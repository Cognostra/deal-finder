#!/usr/bin/env node
import { createStandaloneApp } from "./app.js";
import { resolveStandaloneConfig } from "./config.js";

function readArg(name: string): string | undefined {
  const flag = `--${name}`;
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main() {
  const config = resolveStandaloneConfig({
    host: readArg("host") ?? process.env.DEAL_HUNTER_HOST,
    port: readArg("port") ? Number(readArg("port")) : (process.env.DEAL_HUNTER_PORT ? Number(process.env.DEAL_HUNTER_PORT) : undefined),
    storePath: readArg("store-path") ?? process.env.DEAL_HUNTER_STORE_PATH,
    authToken: readArg("auth-token") ?? process.env.DEAL_HUNTER_AUTH_TOKEN,
    logRequests: process.argv.includes("--log-requests") || process.env.DEAL_HUNTER_LOG_REQUESTS === "true",
    fetcher: (readArg("fetcher") as "local" | "firecrawl" | undefined) ?? (process.env.DEAL_HUNTER_FETCHER as "local" | "firecrawl" | undefined),
    firecrawlApiKey: process.env.FIRECRAWL_API_KEY,
  });
  const app = await createStandaloneApp(config);
  await app.listen({ host: config.host, port: config.port });
  app.log.info(`Deal Hunter standalone listening on http://${config.host}:${config.port}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
