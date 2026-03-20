import fs from "node:fs/promises";
import path from "node:path";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const packageJsonPath = path.join(root, "package.json");
const pluginManifestPath = path.join(root, "openclaw.plugin.json");
const sourceIndexPath = path.join(root, "src", "index.ts");

const packageJson = JSON.parse(await fs.readFile(packageJsonPath, "utf8"));
const pluginManifest = JSON.parse(await fs.readFile(pluginManifestPath, "utf8"));
const sourceIndex = await fs.readFile(sourceIndexPath, "utf8");

pluginManifest.version = packageJson.version;
const nextSourceIndex = sourceIndex.replace(/version:\s*"[^"]+"/, `version: "${packageJson.version}"`);

await fs.writeFile(pluginManifestPath, `${JSON.stringify(pluginManifest, null, 2)}\n`, "utf8");
await fs.writeFile(sourceIndexPath, nextSourceIndex, "utf8");
