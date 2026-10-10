#!/usr/bin/env bash
# Sobe API + agregador fictício com banco temporário, prepara remessas,
# roda o k6 via Docker e verifica as invariantes no fim.
set -euo pipefail

cd "$(dirname "$0")/.."
PORT="${PORT:-3105}"
AGG_PORT="${FAKE_AGGREGATOR_PORT:-3115}"
TMP_DIR="$(mktemp -d)"
EXPECTED_FILE="$TMP_DIR/expected.json"

# Um servidor esquecido de outra rodada responderia no lugar deste e falsearia o resultado.
for p in "$PORT" "$AGG_PORT"; do
  if curl -s -o /dev/null "http://localhost:$p/"; then echo "porta $p já está em uso"; rmdir "$TMP_DIR"; exit 1; fi
done

PORT="$PORT" FAKE_AGGREGATOR_PORT="$AGG_PORT" AGGREGATOR_URL="http://localhost:$AGG_PORT" \
  DB_PATH="$TMP_DIR/load.db" DELAY_LIMIT_HOURS=72 \
  NODE_OPTIONS='--disable-warning=ExperimentalWarning' npx tsx src/index.ts > "$TMP_DIR/server.log" 2>&1 &
SERVER_PID=$!
cleanup() {
  local code=$?
  if [ "$code" -ne 0 ]; then echo "--- log do servidor ---"; tail -40 "$TMP_DIR/server.log"; fi
  kill "$SERVER_PID" 2>/dev/null || true
  wait "$SERVER_PID" 2>/dev/null || true
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

for _ in $(seq 1 50); do
  if curl -sf "http://localhost:$PORT/health" > /dev/null; then break; fi
  sleep 0.2
done
curl -sf "http://localhost:$PORT/health" > /dev/null || { echo "API não subiu"; cat "$TMP_DIR/server.log"; exit 1; }

export API_URL="http://localhost:$PORT" AGG_URL="http://localhost:$AGG_PORT" EXPECTED_FILE
npx tsx scripts/prepare-load.ts

docker run --rm -i \
  --add-host=host.docker.internal:host-gateway \
  -e BASE_URL="http://host.docker.internal:$PORT" \
  -e AGG_URL="http://host.docker.internal:$AGG_PORT" \
  grafana/k6:0.54.0 run --quiet - < load/tracking.js

NODE_OPTIONS='--disable-warning=ExperimentalWarning' npx tsx scripts/verify-load.ts
