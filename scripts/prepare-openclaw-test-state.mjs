import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const stateDir = process.env.OPENCLAW_TEST_STATE_DIR ?? path.join(root, ".openclaw-test");
const configPath = process.env.OPENCLAW_TEST_CONFIG_PATH ?? path.join(root, ".openclaw-test", "openclaw.json");
const sourceStateDir = process.env.OPENCLAW_SOURCE_STATE_DIR ?? path.join(os.homedir(), ".openclaw");

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function copyIfMissing(sourcePath, targetPath) {
  try {
    await fs.access(targetPath);
  } catch {
    try {
      await fs.copyFile(sourcePath, targetPath);
    } catch {
      // The main OpenClaw agent may not exist yet. In that case the test agent
      // starts with empty per-agent state and OpenClaw can populate it later.
    }
  }
}

async function ensureAgentStateDirs() {
  const config = await readJson(configPath);
  const agentIds = new Set(
    (config?.agents?.list ?? [])
      .map((agent) => agent?.id)
      .filter((agentId) => typeof agentId === "string" && agentId.length > 0),
  );

  await fs.mkdir(stateDir, { recursive: true });
  await fs.mkdir(path.join(stateDir, "agents"), { recursive: true });

  await Promise.all(
    [...agentIds].map(async (agentId) => {
      const agentRoot = path.join(stateDir, "agents", agentId);
      const agentConfigDir = path.join(agentRoot, "agent");
      const sessionsDir = path.join(agentRoot, "sessions");
      const mainAgentConfigDir = path.join(sourceStateDir, "agents", "main", "agent");

      await fs.mkdir(agentRoot, { recursive: true });
      await fs.mkdir(agentConfigDir, { recursive: true });
      await fs.mkdir(sessionsDir, { recursive: true });
      await copyIfMissing(
        path.join(mainAgentConfigDir, "auth-profiles.json"),
        path.join(agentConfigDir, "auth-profiles.json"),
      );
      await copyIfMissing(path.join(mainAgentConfigDir, "models.json"), path.join(agentConfigDir, "models.json"));
    }),
  );
}

await ensureAgentStateDirs();
