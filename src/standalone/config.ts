import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { resolveDealConfigFromInput, type ResolvedDealConfig } from "../config.js";
import type { DealHunterPluginConfig } from "../types.js";

export type StandaloneConfigInput = DealHunterPluginConfig & {
  host?: string;
  port?: number;
  authToken?: string;
  logRequests?: boolean;
  stateDir?: string;
};

export type ResolvedStandaloneConfig = {
  host: string;
  port: number;
  authToken?: string;
  logRequests: boolean;
  stateDir: string;
  deal: ResolvedDealConfig;
};

function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return normalized === "127.0.0.1" || normalized === "::1" || normalized === "localhost";
}

export function resolveStandaloneConfig(
  raw: StandaloneConfigInput,
  args?: {
    cwd?: string;
    homeDir?: string;
  },
): ResolvedStandaloneConfig {
  const cwd = args?.cwd ?? process.cwd();
  const homeDir = args?.homeDir ?? homedir();
  const host = raw.host?.trim() || "127.0.0.1";
  const port = raw.port ?? 3210;
  const authToken = raw.authToken?.trim() || undefined;
  const stateDir = raw.stateDir
    ? (isAbsolute(raw.stateDir) ? raw.stateDir : resolve(cwd, raw.stateDir))
    : join(homeDir, ".deal-hunter-standalone");

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("deal-hunter: standalone port must be an integer between 1 and 65535");
  }
  if (!isLoopbackHost(host) && !authToken) {
    throw new Error("deal-hunter: standalone authToken is required when binding outside localhost");
  }

  return {
    host,
    port,
    authToken,
    logRequests: raw.logRequests === true,
    stateDir,
    deal: resolveDealConfigFromInput(raw, {
      defaultBaseDir: stateDir,
      resolvePath: (input) => (isAbsolute(input) ? input : resolve(cwd, input)),
    }),
  };
}
