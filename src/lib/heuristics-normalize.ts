import { createHash } from "node:crypto";

export function hashSnippet(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 32);
}

export function canonicalizeTitle(title?: string): string | undefined {
  if (!title) return undefined;
  const normalized = title
    .replace(/[™®©]/g, "")
    .normalize("NFKC")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/[–—]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return undefined;
  return normalized.toLowerCase();
}
