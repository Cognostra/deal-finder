# OpenClaw Deal Hunter

OpenClaw plugin: watch product URLs, scan with **conditional GET** (`ETag` / `Last-Modified`), **streaming byte caps**, shared **undici** connection pooling, and TypeScript heuristic deal signals.

The extraction stack is layered:

- retailer-aware extractors for common HTML patterns
- JSON-LD / OpenGraph extraction
- bounded regex fallback for visible prices

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
          "deal_watch_bulk_update",
          "deal_watch_tag",
          "deal_watch_dedupe",
          "deal_watch_export",
          "deal_watch_import",
          "deal_watch_import_url",
          "deal_watch_remove",
          "deal_scan",
          "deal_fetch_url",
          "deal_extraction_debug",
          "deal_evaluate_text",
          "deal_help",
          "deal_quickstart",
          "deal_report",
          "deal_health",
          "deal_history",
          "deal_alerts",
          "deal_trends",
          "deal_top_drops",
          "deal_watch_insights",
          "deal_schedule_advice",
          "deal_doctor",
          "deal_sample_setup"
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
| `deal_watch_search` | Search/filter/sort watches by query, enabled state, snapshot state, signals, tag, group, or price. |
| `deal_watch_bulk_update` | Bulk-update watches selected by ids or search filters; dry-run by default. |
| `deal_watch_tag` | Add, remove, or replace tags and assign groups across matching watches. |
| `deal_watch_dedupe` | Find or resolve likely duplicate watches using canonicalized URLs. |
| `deal_watch_export` | Export watches, optionally including snapshots and history, for backup or migration. |
| `deal_watch_import` | Import watches with `append`, `upsert`, `replace`, and `dryRun` support. |
| `deal_watch_import_url` | Fetch a remote JSON watchlist over HTTP(S), validate it, and import it with dry-run support. |
| `deal_watch_remove` | Remove by `watchId`. |
| `deal_scan` | Scan all enabled watches (or `watchIds`); `commit: false` dry-run. |
| `deal_fetch_url` | One-off capped fetch + heuristic extraction. |
| `deal_extraction_debug` | Show heuristic extraction candidates, chosen fields, and confidence reasons for one URL. |
| `deal_evaluate_text` | Score pasted text for “freebie / glitchy” wording (no network). |
| `deal_help` | Show install, tool, cron, and safety guidance from inside OpenClaw. |
| `deal_quickstart` | Show a first-run checklist, starter prompts, and privacy/safety reminders. |
| `deal_report` | Summarize the watchlist, price leaders, recent changes, noisy watches, and glitch candidates. |
| `deal_health` | Show configuration, storage, safety posture, and operational recommendations. |
| `deal_history` | Show per-watch price history, recent deltas, and lowest/highest seen prices. |
| `deal_alerts` | Rank current threshold, keyword, and recent high-severity watch signals. |
| `deal_trends` | Summarize falling, rising, flat, and volatile watches with compact sparklines. |
| `deal_top_drops` | Rank the strongest deals by discount from peak or the latest committed drop. |
| `deal_watch_insights` | Explain one watch in depth: trend, volatility, glitch risk, and active signals. |
| `deal_schedule_advice` | Recommend scan cadence by host or watch from observed history timing. |
| `deal_doctor` | Run a lightweight sanity check for config and watchlist setup. |
| `deal_sample_setup` | Show install, config, allowlist, prompt, and cron examples. |

Side-effecting tools are registered as **optional** (except `deal_watch_list` / `deal_evaluate_text`) so you opt in via `tools.allow`.

Recommended first-run workflow:

1. `deal_quickstart` for the shortest safe first-run checklist.
2. `deal_help` for install/tool guidance and sample prompts.
3. `deal_sample_setup` for ready-to-copy install/config/cron examples.
4. `deal_watch_add` to create the first watch.
5. `deal_watch_search` to inspect watches and current threshold/keyword signals.
6. `deal_watch_tag` or `deal_watch_bulk_update` to organize watches into tags and groups as the list grows.
7. `deal_watch_dedupe` in dry-run mode before imports or cleanup work.
8. `deal_scan` with `commit: true` to capture snapshots.
9. `deal_history`, `deal_alerts`, `deal_trends`, and `deal_top_drops` to inspect recent movement and ranked opportunities.
10. `deal_watch_export` before major cleanup work or when moving watches to another workspace.
11. `deal_watch_import` with `dryRun: true` before applying migrated watchlists from a local export.
12. `deal_watch_import_url` with `dryRun: true` before applying a shared remote watchlist.
13. `deal_watch_update` or `deal_watch_set_enabled` for single-watch changes.
14. `deal_watch_insights`, `deal_schedule_advice`, `deal_report`, `deal_health`, and `deal_doctor` to audit the current state of the plugin.

`deal_scan` responses now include compact model-friendly fields per watch:

- `changed`, `changeType`, `changeReasons`
- `previousPrice`, `currentPrice`, `priceDelta`, `percentDelta`
- `alertSeverity`, `alertScore`, `extractionConfidence`
- `fetchSource`, `fetchSourceNote`
- `summaryLine`
- top-level `summary` and `rankedAlerts`

Snapshot and extraction metadata also include `canonicalTitle`, which normalizes cosmetic title differences for cleaner watch metadata and more stable agent summaries.

The current retailer-aware extractor pack includes fixture-backed support for:

- Amazon-style product pages
- Best Buy-style product pages
- eBay-style product pages
- Target-style product pages
- Walmart-style product pages
- Newegg-style product pages
- Home Depot-style product pages

`deal_extraction_debug` now shows:

- which extractor matched, if any
- title and price candidates by source
- the chosen title/price source
- extraction confidence reasons

Committed scans now build bounded per-watch history so the plugin can report:

- lowest seen price
- highest seen price
- latest price delta
- recent alert-bearing changes

`deal_report` now also highlights:

- `recentChanges` for the latest committed movements across the watchlist
- `noisyWatches` for products whose recent history looks unusually volatile
- `glitchCandidates` for near-zero or extreme-drop cases worth manual review

The analytics tools add:

- `deal_trends` for compact per-watch direction and volatility summaries
- `deal_top_drops` for ranking discounts against historical peaks or the latest committed move
- `deal_watch_insights` for one-watch explanations with sparkline context
- `deal_schedule_advice` for host-level or watch-level scan cadence suggestions

`deal_alerts` now includes `glitchScore` and `glitchReasons` so small models can distinguish normal threshold hits from suspicious freebie-like results.

`deal_watch_import` supports:

- `append` to always create new watches
- `upsert` to match by `id` first, then `url`
- `replace` to swap the current watchlist with the imported one
- `dryRun` to preview the result before writing

`deal_watch_import_url` supports:

- remote JSON arrays of watches
- prior `deal_watch_export` payloads with a top-level `watches` array
- `dryRun` by default so remote imports are previewed before writing
- per-run `group`, `addTags`, and `enabled` overrides
- recorded `importSource` metadata so shared-list provenance stays visible on imported watches

Watch management now also includes:

- URL canonicalization that strips common tracking params before storage and dedupe checks
- optional `group` and `tags` metadata for organizing larger watchlists
- bulk update and tag tools that are dry-run-first for safer agent workflows
- dedupe reporting and duplicate resolution based on canonicalized URLs

Network guardrails:

- Watch and fetch URLs must be `http` or `https`.
- Localhost and private-network IP literals are blocked by default.
- Hostnames that resolve to private or loopback IPs are blocked at fetch time.
- `allowedHosts` and `blockedHosts` can further restrict where the plugin is allowed to connect.
- Redirect targets are validated before the plugin follows them.

## Privacy & data

- Watch metadata, the latest snapshot, and committed history are stored in the configured JSON store path.
- Exported watchlists may include URLs, thresholds, snapshots, and history if you choose to include them.
- `deal_watch_import` supports `dryRun` so you can preview changes before writing them to disk.
- `deal_watch_import_url` records the source URL and import timestamp on affected watches.
- `allowedHosts` is the best way to keep the plugin constrained to the domains you actually want it to touch.

## Troubleshooting

- Use `deal_quickstart` if you want the shortest safe first-run path.
- Use `deal_doctor` for a quick sanity check.
- Use `deal_health` to inspect active limits, fetcher choice, and host-policy posture.
- Use `deal_fetch_url` when you need a quick raw preview.
- Use `deal_extraction_debug` when extraction quality looks weak and you want to inspect candidates, chosen fields, and confidence reasons.
- If a URL is blocked, compare it against your `allowedHosts` and `blockedHosts` settings first.

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
npm run audit:prod
npm run audit:full
npm run release:verify
```

If test execution ever hangs or exits oddly on your machine, run:

```bash
npm run test:diagnose
```

That command prints the active `node` resolution and then runs Vitest with the `hanging-process` reporter under a real-Node-first `PATH`. This matters on systems where `node` is aliased or symlinked to Bun.

`npm run release:verify` builds a real tarball, installs it into a fresh temporary OpenClaw state using the local `openclaw/` source checkout, and lists plugins to confirm the package installs cleanly as an archive.

`npm run audit:prod` checks the published runtime dependency tree only. `npm run audit:full` includes dev dependencies as well, which is useful for tracking issues inherited from the local OpenClaw test harness and other development-only tooling.

## License

MIT
