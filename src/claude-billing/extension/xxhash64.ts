/**
 * XXH64, the hash Claude Code uses for its `cch` billing attestation.
 *
 * Node has no built-in XXH64 (`node:crypto` exposes sha/md5/blake only) and Pi
 * runs on Node, so the reference algorithm is implemented here over BigInt.
 * Bun exposes `Bun.hash.xxHash64`; the test suite pins this implementation
 * against it so a divergence cannot ship silently.
 *
 * Reference: https://github.com/Cyan4973/xxHash/blob/dev/doc/xxhash_spec.md
 */

const PRIME64_1 = 0x9e3779b185ebca87n;
const PRIME64_2 = 0xc2b2ae3d27d4eb4fn;
const PRIME64_3 = 0x165667b19e3779f9n;
const PRIME64_4 = 0x85ebca77c2b2ae63n;
const PRIME64_5 = 0x27d4eb2f165667c5n;
const MASK64 = 0xffffffffffffffffn;

const rotl = (value: bigint, bits: bigint): bigint =>
  ((value << bits) | (value >> (64n - bits))) & MASK64;

const mul = (a: bigint, b: bigint): bigint => (a * b) & MASK64;

function round(accumulator: bigint, lane: bigint): bigint {
  return mul(
    rotl((accumulator + mul(lane, PRIME64_2)) & MASK64, 31n),
    PRIME64_1,
  );
}

function mergeRound(accumulator: bigint, lane: bigint): bigint {
  return (mul(accumulator ^ round(0n, lane), PRIME64_1) + PRIME64_4) & MASK64;
}

function read64LE(bytes: Uint8Array, offset: number): bigint {
  let value = 0n;
  for (let index = 7; index >= 0; index--) {
    value = (value << 8n) | BigInt(bytes[offset + index]);
  }
  return value;
}

function read32LE(bytes: Uint8Array, offset: number): bigint {
  return (
    BigInt(bytes[offset]) |
    (BigInt(bytes[offset + 1]) << 8n) |
    (BigInt(bytes[offset + 2]) << 16n) |
    (BigInt(bytes[offset + 3]) << 24n)
  );
}

/** XXH64 of `input` under `seed`. Returns the full 64-bit digest. */
export function xxHash64(input: Uint8Array, seed: bigint): bigint {
  const length = BigInt(input.length);
  let offset = 0;
  let hash: bigint;

  if (input.length >= 32) {
    let v1 = (seed + PRIME64_1 + PRIME64_2) & MASK64;
    let v2 = (seed + PRIME64_2) & MASK64;
    let v3 = seed & MASK64;
    let v4 = (seed - PRIME64_1) & MASK64;

    const limit = input.length - 32;
    while (offset <= limit) {
      v1 = round(v1, read64LE(input, offset));
      v2 = round(v2, read64LE(input, offset + 8));
      v3 = round(v3, read64LE(input, offset + 16));
      v4 = round(v4, read64LE(input, offset + 24));
      offset += 32;
    }

    hash =
      (rotl(v1, 1n) + rotl(v2, 7n) + rotl(v3, 12n) + rotl(v4, 18n)) & MASK64;
    hash = mergeRound(hash, v1);
    hash = mergeRound(hash, v2);
    hash = mergeRound(hash, v3);
    hash = mergeRound(hash, v4);
  } else {
    hash = (seed + PRIME64_5) & MASK64;
  }

  hash = (hash + length) & MASK64;

  while (offset + 8 <= input.length) {
    hash =
      (mul(rotl(hash ^ round(0n, read64LE(input, offset)), 27n), PRIME64_1) +
        PRIME64_4) &
      MASK64;
    offset += 8;
  }

  if (offset + 4 <= input.length) {
    hash =
      (mul(
        rotl(hash ^ mul(read32LE(input, offset), PRIME64_1), 23n),
        PRIME64_2,
      ) +
        PRIME64_3) &
      MASK64;
    offset += 4;
  }

  while (offset < input.length) {
    hash = mul(
      rotl(hash ^ mul(BigInt(input[offset]), PRIME64_5), 11n),
      PRIME64_1,
    );
    offset += 1;
  }

  hash ^= hash >> 33n;
  hash = mul(hash, PRIME64_2);
  hash ^= hash >> 29n;
  hash = mul(hash, PRIME64_3);
  hash ^= hash >> 32n;
  return hash;
}

/** Low 20 bits of XXH64 as Claude Code's 5-hex-character `cch` value. */
export function cchDigest(input: Uint8Array, seed: bigint): string {
  return (xxHash64(input, seed) & 0xfffffn).toString(16).padStart(5, "0");
}
