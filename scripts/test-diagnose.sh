#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

echo "pwd: $PWD"
echo "node (shell): $(command -v node)"
echo "node (resolved): $(readlink -f "$(command -v node)" 2>/dev/null || command -v node)"
echo "system node: $(command -v /usr/bin/node)"
/usr/bin/node -v
echo "npm: $(command -v npm)"
echo "vitest bin: $ROOT/node_modules/.bin/vitest"

exec env PATH="/usr/bin:/bin:$PATH" \
  ./node_modules/.bin/vitest run --configLoader runner --reporter=hanging-process "$@"
