import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const targetConfigPath = process.env.OPENCLAW_TEST_CONFIG_PATH ?? path.join(root, ".openclaw-test", "openclaw.json");
const sourceConfigPath =
  process.env.OPENCLAW_SOURCE_CONFIG_PATH ?? path.join(os.homedir(), ".openclaw", "openclaw.json");

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

function syncModelSelection(target, source) {
  const sourceDefaults = source?.agents?.defaults ?? {};
  const targetDefaults = target?.agents?.defaults ?? {};

  if (sourceDefaults.model) targetDefaults.model = sourceDefaults.model;
  else delete targetDefaults.model;

  if (sourceDefaults.models) targetDefaults.models = sourceDefaults.models;
  else delete targetDefaults.models;

  target.agents ??= {};
  target.agents.defaults = targetDefaults;

  if (source.auth) target.auth = source.auth;
  else delete target.auth;

  if (source.models) target.models = source.models;
  else delete target.models;
}

async function main() {
  const target = await readJson(targetConfigPath);
  if (target.meta) {
    delete target.meta.syncedModelSource;
    delete target.meta.syncedAt;
  }

  try {
    const source = await readJson(sourceConfigPath);
    syncModelSelection(target, source);
  } catch {
    // Keep the repo-local config valid even when the main OpenClaw config
    // does not exist yet. In that case we leave the current model/auth
    // selection untouched.
  }

  await fs.writeFile(targetConfigPath, `${JSON.stringify(target, null, 2)}\n`, "utf8");
}

await main();
