#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OPENCLAW_DIR="$ROOT/openclaw"

if [[ ! -d "$OPENCLAW_DIR" ]]; then
  echo "openclaw source checkout not found at $OPENCLAW_DIR" >&2
  exit 1
fi

PACK_DIR="$(mktemp -d /tmp/openclaw-deal-hunter-pack.XXXXXX)"
STATE_DIR="$(mktemp -d /tmp/openclaw-deal-hunter-state.XXXXXX)"
trap 'rm -rf "$PACK_DIR" "$STATE_DIR"' EXIT

pushd "$ROOT" >/dev/null
TARBALL="$(env NPM_CONFIG_CACHE=/tmp/openclaw-deal-hunter-npm-cache npm pack --pack-destination "$PACK_DIR" | tail -n 1)"
popd >/dev/null

TARBALL_PATH="$PACK_DIR/$TARBALL"
CONFIG_PATH="$STATE_DIR/openclaw.json"

pushd "$OPENCLAW_DIR" >/dev/null
OPENCLAW_STATE_DIR="$STATE_DIR" \
OPENCLAW_CONFIG_PATH="$CONFIG_PATH" \
  /usr/bin/node openclaw.mjs plugins install "$TARBALL_PATH"

OPENCLAW_STATE_DIR="$STATE_DIR" \
OPENCLAW_CONFIG_PATH="$CONFIG_PATH" \
  /usr/bin/node openclaw.mjs plugins list
popd >/dev/null
