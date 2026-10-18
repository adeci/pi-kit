import { expect, test } from "bun:test";
import { cchDigest, xxHash64 } from "./xxhash64";

const encoder = new TextEncoder();
const CCH_SEED = 0x4d659218e32a3268n;

// Published XXH64 vectors (seed 0). These pin the algorithm itself; the Bun
// comparison below pins it against the implementation oh-my-pi uses.
const specVectors: [string, bigint][] = [
  ["", 0xef46db3751d8e999n],
  ["a", 0xd24ec4f1a98c6e5bn],
  ["abc", 0x44bc2cf5ad770999n],
  ["Nobody inspects the spammish repetition", 0xfbcea83c8a378bf1n],
];

test("matches published XXH64 vectors", () => {
  for (const [input, expected] of specVectors) {
    expect(xxHash64(encoder.encode(input), 0n)).toBe(expected);
  }
});

test("matches Bun.hash.xxHash64 across lengths and the billing seed", () => {
  for (let length = 0; length <= 300; length++) {
    const bytes = new Uint8Array(length);
    for (let index = 0; index < length; index++) {
      bytes[index] = (index * 37 + 11) & 0xff;
    }
    expect(xxHash64(bytes, CCH_SEED)).toBe(
      BigInt(Bun.hash.xxHash64(bytes, CCH_SEED)),
    );
  }
});

test("cch digest is the low 20 bits as five lowercase hex characters", () => {
  const body = encoder.encode('{"model":"claude-opus-4-8","stream":true}');
  expect(cchDigest(body, CCH_SEED)).toBe(
    (BigInt(Bun.hash.xxHash64(body, CCH_SEED)) & 0xfffffn)
      .toString(16)
      .padStart(5, "0"),
  );
  expect(cchDigest(body, CCH_SEED)).toMatch(/^[0-9a-f]{5}$/);
});
