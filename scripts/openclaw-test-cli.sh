#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE_DIR="${OPENCLAW_TEST_STATE_DIR:-$ROOT/.openclaw-test}"
CONFIG_PATH="${OPENCLAW_TEST_CONFIG_PATH:-$ROOT/.openclaw-test/openclaw.json}"

/usr/bin/node "$ROOT/scripts/sync-openclaw-test-config.mjs"
OPENCLAW_TEST_STATE_DIR="$STATE_DIR" OPENCLAW_TEST_CONFIG_PATH="$CONFIG_PATH" \
  /usr/bin/node "$ROOT/scripts/prepare-openclaw-test-state.mjs"

cd "$ROOT/openclaw"

exec env \
  PATH="$ROOT/scripts:/usr/bin:/usr/local/bin:$PATH" \
  OPENCLAW_STATE_DIR="$STATE_DIR" \
  OPENCLAW_CONFIG_PATH="$CONFIG_PATH" \
  /usr/bin/node openclaw.mjs "$@"
