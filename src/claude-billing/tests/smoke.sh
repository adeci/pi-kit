#!/usr/bin/env bash
# Verify the claude-billing extension against a real pi binary.
#
#   smoke.sh <pi-binary> [model-id]
#
# Drives pi against a local capture server with a fake subscription token and
# asserts, on the request pi actually put on the wire:
#   1. the OAuth request carries the Claude Code billing header as system[0]
#   2. `cch` recomputes from the body, using this repo's own XXH64
#   3. the version suffix recomputes from the first user message
#   4. the advertised version still matches this extension's constant
#   5. the stock `anthropic` provider still sends no billing header
#   6. an API-key request still sends no billing header
#
# The model id is discovered from pi's own catalog, so a catalog rename does
# not break the check.
#
# Run it after every pi version bump. It fails loudly if pi stops plumbing
# `onPayload`/`fetch` through the Anthropic transport, or if the version this
# extension advertises has drifted from the one pi puts in its user agent —
# both of which are otherwise silent.
set -euo pipefail

PI_BIN=${1:?usage: smoke.sh <pi-binary> [model-id]}
EXTENSION=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/extension
BUN=${BUN:-bun}
PORT=${PORT:-8791}

work=$(mktemp -d)
server=""
cleanup() {
  [ -n "$server" ] && kill "$server" 2>/dev/null || true
  rm -rf "$work"
}
trap cleanup EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

for agent in sub stock; do
  mkdir -p "$work/$agent"
  echo '{}' >"$work/$agent/settings.json"
  printf '{"providers":{"%s":{"baseUrl":"http://127.0.0.1:%s"}}}' \
    "$([ "$agent" = sub ] && echo anthropic-sub || echo anthropic)" "$PORT" \
    >"$work/$agent/models.json"
done
for agent in sub stock; do
  printf '{"%s":{"type":"oauth","access":"sk-ant-oat01-smoke-access-token","refresh":"sk-ant-ort01-smoke-refresh-token","expires":4102444800000}}' \
    "$([ "$agent" = sub ] && echo anthropic-sub || echo anthropic)" \
    >"$work/$agent/auth.json"
done

cat >"$work/capture.py" <<PY
import http.server, socketserver
SSE = (
 'event: message_start\ndata: {"type":"message_start","message":{"id":"m","type":"message","role":"assistant","model":"x","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":1}}}\n\n'
 'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n'
 'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}\n\n'
 'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n'
 'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":1}}\n\n'
 'event: message_stop\ndata: {"type":"message_stop"}\n\n'
).encode()
class H(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    def do_POST(self):
        open("$work/body.json", "wb").write(self.rfile.read(int(self.headers.get("content-length", 0))))
        self.send_response(200)
        self.send_header("content-type", "text/event-stream")
        self.send_header("content-length", str(len(SSE)))
        self.end_headers()
        self.wfile.write(SSE)
    def log_message(self, *a): pass
socketserver.TCPServer.allow_reuse_address = True
socketserver.TCPServer(("127.0.0.1", $PORT), H).serve_forever()
PY

python3 "$work/capture.py" &
server=$!
for _ in $(seq 1 50); do
  curl -s -o /dev/null -X POST "http://127.0.0.1:$PORT/" -d '{}' && break
  sleep 0.1
done

if [ -n "${2:-}" ]; then
  MODEL=$2
else
  MODEL=$(
    PI_CODING_AGENT_DIR="$work/sub" "$PI_BIN" --list-models --extension "$EXTENSION" 2>/dev/null |
      awk '$1 == "anthropic-sub" { print $2; exit }'
  ) || true
  [ -n "$MODEL" ] || fail "no anthropic-sub model in pi's catalog"
fi
echo "model: $MODEL"

run() {
  rm -f "$work/body.json"
  PI_CODING_AGENT_DIR="$work/$1" timeout 120 "$PI_BIN" --print \
    --model "$2" --extension "$EXTENSION" "${@:3}" "smoke" >/dev/null 2>&1 || true
  [ -f "$work/body.json" ] || fail "$1: pi sent no request"
}

echo "== subscription request (anthropic-sub)"
run sub "anthropic-sub/$MODEL"
grep -q 'x-anthropic-billing-header' "$work/body.json" ||
  fail "billing header missing: pi stopped plumbing onPayload/fetch"
grep -q '"system":\[{"type":"text","text":"x-anthropic-billing-header' "$work/body.json" ||
  fail "billing header is not the first system block"

"$BUN" run "$(dirname "${BASH_SOURCE[0]}")/verify.ts" "$work/body.json" ||
  fail "cch or version suffix did not recompute"

echo "== stock provider control (anthropic)"
run stock "anthropic/$MODEL"
grep -q 'x-anthropic-billing-header' "$work/body.json" &&
  fail "stock anthropic provider must not be attested" || true

echo "== api-key control (anthropic-sub)"
run sub "anthropic-sub/$MODEL" --api-key sk-ant-api03-smoke
grep -q 'x-anthropic-billing-header' "$work/body.json" &&
  fail "api-key request must not be attested" || true

echo "== api-key control (anthropic, the built-in provider)"
run stock "anthropic/$MODEL" --api-key sk-ant-api03-smoke
grep -q 'x-anthropic-billing-header' "$work/body.json" &&
  fail "api-key request must not be attested" || true

echo "PASS"
