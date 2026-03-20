#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

cd "$ROOT"

PROMPT="${1:-Use deal_watch_list and tell me how many watches exist and whether any are enabled. Keep it to one short paragraph.}"

exec timeout 90s \
  ./scripts/openclaw-test-cli.sh agent \
  --agent deal-finder-test \
  --thinking low \
  --message "$PROMPT"
