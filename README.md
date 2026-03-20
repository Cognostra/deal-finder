# OpenClaw Deal Hunter

OpenClaw plugin: watch product URLs, scan with **conditional GET** (`ETag` / `Last-Modified`), **streaming byte caps**, shared **undici** connection pooling, and TypeScript heuristic deal signals.

## Ethics & responsibility

- You are responsible for complying with each site’s **terms of service** and `robots.txt`. This plugin does not bypass CAPTCHAs or anti-bot systems.
- Built-in **per-host spacing** and global concurrency caps reduce accidental load; tune `defaultMaxRpsPerHost` and `maxConcurrent` for your environment.
- Examples in this readme are illustrative only.

## Install

Requires **Node >= 20** and OpenClaw Gateway with plugin loading enabled.

Source repo:

`https://github.com/Cognostra/deal-finder`

Important install note:

- For native OpenClaw plugins, the supported public install path is an npm package spec such as `openclaw plugins install <npm-spec>`.
- The OpenClaw CLI does **not** accept a GitHub repo URL as a native plugin install spec.
- GitHub should be treated as the source/support repo; npm is the easy end-user install path.

Primary install path:

```bash
openclaw plugins install openclaw-deal-hunter
```

Local source install for development:

```bash
cd /path/to/deal-finder
npm install
npm run build
openclaw plugins install -l .
```

Enable the plugin and tools in your OpenClaw config, for example:

```json5
plugins: {
  entries: {
    "openclaw-deal-hunter": {
      enabled: true,
      config: {
        maxConcurrent: 8,
        maxBytesPerResponse: 1048576,
        defaultMaxRpsPerHost: 1,
        allowedHosts: ["*.example.com"],
        blockedHosts: ["localhost"],
        fetcher: "local"
      }
    }
  }
}
```

Update or remove:

```bash
openclaw plugins install openclaw-deal-hunter@latest
openclaw plugins remove openclaw-deal-hunter
```

Allow-list tools for your agent (names must be explicitly allowed when using plugin-only tool policy):

```json5
agents: {
  list: [
    {
      id: "main",
      tools: {
        allow: [
          "openclaw-deal-hunter",
          "deal_watch_list",
          "deal_watch_add",
          "deal_watch_update",
          "deal_watch_set_enabled",
          "deal_watch_search",
          "deal_watch_remove",
          "deal_scan",
          "deal_fetch_url",
          "deal_evaluate_text",
          "deal_help",
          "deal_report",
          "deal_health"
        ]
      }
    }
  ]
}
```

## Tools

| Tool | Purpose |
|------|---------|
| `deal_watch_list` | List watches and last snapshots. |
| `deal_watch_add` | Add a URL with optional `maxPrice`, `percentDrop`, `keywords`. |
| `deal_watch_update` | Update a watch’s URL, thresholds, label, keywords, or enabled state. |
| `deal_watch_set_enabled` | Enable or disable one or more watches in bulk. |
| `deal_watch_search` | Search/filter/sort watches by query, enabled state, snapshot state, signals, or price. |
| `deal_watch_remove` | Remove by `watchId`. |
| `deal_scan` | Scan all enabled watches (or `watchIds`); `commit: false` dry-run. |
| `deal_fetch_url` | One-off capped fetch + heuristic extraction. |
| `deal_evaluate_text` | Score pasted text for “freebie / glitchy” wording (no network). |
| `deal_help` | Show install, tool, cron, and safety guidance from inside OpenClaw. |
| `deal_report` | Summarize the current watchlist, snapshots, and signal-heavy watches. |
| `deal_health` | Show configuration, storage, safety posture, and operational recommendations. |

Side-effecting tools are registered as **optional** (except `deal_watch_list` / `deal_evaluate_text`) so you opt in via `tools.allow`.

Recommended first-run workflow:

1. `deal_help` for install/tool guidance and sample prompts.
2. `deal_watch_add` to create the first watch.
3. `deal_watch_search` to inspect watches and current threshold/keyword signals.
4. `deal_scan` with `commit: true` to capture snapshots.
5. `deal_watch_update` or `deal_watch_set_enabled` as the watchlist grows.
6. `deal_report` and `deal_health` to audit the current state of the plugin.

`deal_scan` responses now include compact model-friendly fields per watch:

- `changed`, `changeType`, `changeReasons`
- `previousPrice`, `currentPrice`, `priceDelta`, `percentDelta`
- `alertSeverity`, `alertScore`, `extractionConfidence`
- `fetchSource`, `fetchSourceNote`
- `summaryLine`
- top-level `summary` and `rankedAlerts`

Snapshot and extraction metadata also include `canonicalTitle`, which normalizes cosmetic title differences for cleaner watch metadata and more stable agent summaries.

Network guardrails:

- Watch and fetch URLs must be `http` or `https`.
- Localhost and private-network IP literals are blocked by default.
- Hostnames that resolve to private or loopback IPs are blocked at fetch time.
- `allowedHosts` and `blockedHosts` can further restrict where the plugin is allowed to connect.
- Redirect targets are validated before the plugin follows them.

## Proactive scans (cron)

Use OpenClaw’s scheduler so the agent runs a batch scan on a cadence, then announces to your channel. Example pattern:

```bash
openclaw cron add \
  --name "Deal scan" \
  --cron "0 * * * *" \
  --tz "America/Los_Angeles" \
  --session isolated \
  --message "Run deal_scan with commit true for all enabled watches. If any result has non-empty alerts, summarize the best deals for me." \
  --announce \
  --channel telegram \
  --to "user:YOUR_TARGET"
```

Adjust `--channel` / `--to` for Discord, Slack, WhatsApp, or use [webhook delivery](https://docs.openclaw.ai/automation/cron-jobs) per OpenClaw docs.

## Optional Firecrawl fetcher

Set `fetcher: "firecrawl"` and provide `firecrawlApiKey` (and optionally `firecrawlBaseUrl`) to route listing retrieval through Firecrawl’s scrape API instead of direct `GET`.

Notes:

- Firecrawl is currently supported in the Node engine path.
- `deal_scan` now loads the store under lock, releases the lock while network requests run, and re-locks only for commit/merge.

## Publishing and listing

For a community-listed OpenClaw plugin, the expected public shape is:

- npm-published package
- public GitHub repository
- setup/use docs
- issue tracker

That means this repo should be the public source of truth, but end-user installs should point at the npm package, not the GitHub URL.

## Local OpenClaw test harness

Development/testing only.

This repo includes an isolated harness that does not touch your main `~/.openclaw` state:

```bash
./scripts/openclaw-test-cli.sh plugins list
./scripts/openclaw-test-cli.sh gateway --port 18789 --verbose
./scripts/openclaw-test-cli.sh gateway status
```

Notes:

- test config lives at `./.openclaw-test/openclaw.json`
- wrapper script syncs model/auth selection from your main `~/.openclaw/openclaw.json` into the repo-local test config before each run
- by default the harness uses an isolated repo-local state dir at `./.openclaw-test`, while inheriting the model/provider you chose during OpenClaw setup
- the wrapper also seeds the repo-local test agent from your main OpenClaw agent state when per-agent model/auth files are available
- repo-local workspace and plugin store stay under `./.openclaw-test`
- the test agent id is `deal-finder-test` to avoid colliding with your normal `main` agent sessions
- stop the foreground gateway with `Ctrl+C`

Provider/model sanity commands:

```bash
ollama list
./scripts/openclaw-test-cli.sh models list
```

Simple local agent/tool turn:

```bash
./scripts/openclaw-agent-smoke.sh
```

Equivalent direct command:

```bash
./scripts/openclaw-test-cli.sh agent \
  --agent deal-finder-test \
  --thinking low \
  --message "Use deal_watch_list and tell me how many watches exist and whether any are enabled. Keep it to one short paragraph."
```

If you want to point the harness at your real OpenClaw state dir instead of the repo-local isolated test state:

```bash
OPENCLAW_TEST_STATE_DIR="$HOME/.openclaw" ./scripts/openclaw-test-cli.sh ...
```

## Development

```bash
npm run build
npm test
```

If test execution ever hangs or exits oddly on your machine, run:

```bash
npm run test:diagnose
```

That command prints the active `node` resolution and then runs Vitest with the `hanging-process` reporter under a real-Node-first `PATH`. This matters on systems where `node` is aliased or symlinked to Bun.

## License

MIT
