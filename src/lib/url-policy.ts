import { isIP } from "node:net";
import { lookup } from "node:dns/promises";

export type UrlPolicyConfig = {
  allowedHosts?: string[];
  blockedHosts?: string[];
};

function normalizeHostname(hostname: string): string {
  const trimmed = hostname.trim().toLowerCase();
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function matchesHostPattern(hostname: string, pattern: string): boolean {
  if (!pattern) return false;
  if (pattern.startsWith("*.")) {
    const suffix = pattern.slice(2);
    return Boolean(suffix) && hostname !== suffix && hostname.endsWith(`.${suffix}`);
  }
  return hostname === pattern;
}

function isLocalHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "localhost.localdomain" || hostname.endsWith(".localhost");
}

function isPrivateIpv4(hostname: string): boolean {
  const parts = hostname.split(".").map((part) => Number.parseInt(part, 10));
  if (parts.length !== 4 || parts.some((part) => Number.isNaN(part) || part < 0 || part > 255)) {
    return false;
  }
  const [a, b] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function expandIpv6Segments(hostname: string): number[] | null {
  const normalized = normalizeHostname(hostname);
  if (isIP(normalized) !== 6) return null;

  const parts = normalized.split("::");
  if (parts.length > 2) return null;

  const parsePart = (part: string): number[] => {
    if (!part) return [];
    return part.split(":").flatMap((segment) => {
      if (!segment) return [];
      if (segment.includes(".")) {
        if (isIP(segment) !== 4) return [Number.NaN];
        const octets = segment.split(".").map((item) => Number.parseInt(item, 10));
        return [(octets[0] << 8) | octets[1], (octets[2] << 8) | octets[3]];
      }
      return [Number.parseInt(segment, 16)];
    });
  };

  const left = parsePart(parts[0] ?? "");
  const right = parsePart(parts[1] ?? "");
  if ([...left, ...right].some((segment) => Number.isNaN(segment) || segment < 0 || segment > 0xffff)) {
    return null;
  }

  if (parts.length === 1) {
    return left.length === 8 ? left : null;
  }

  const zeros = 8 - (left.length + right.length);
  if (zeros < 1) return null;
  return [...left, ...new Array<number>(zeros).fill(0), ...right];
}

function extractMappedIpv4(hostname: string): string | null {
  const segments = expandIpv6Segments(hostname);
  if (!segments) return null;
  const isMapped =
    segments[0] === 0 &&
    segments[1] === 0 &&
    segments[2] === 0 &&
    segments[3] === 0 &&
    segments[4] === 0 &&
    segments[5] === 0xffff;
  if (!isMapped) return null;
  return [
    segments[6] >> 8,
    segments[6] & 0xff,
    segments[7] >> 8,
    segments[7] & 0xff,
  ].join(".");
}

function isPrivateIpv6(hostname: string): boolean {
  const lower = normalizeHostname(hostname);
  if (lower === "::" || lower === "::1") return true;
  if (/^fc/i.test(lower) || /^fd/i.test(lower)) return true;
  if (/^fe[89ab]/i.test(lower)) return true;
  const mappedIpv4 = extractMappedIpv4(lower);
  return mappedIpv4 ? isPrivateIpv4(mappedIpv4) : false;
}

function isUnsafeIpLiteral(hostname: string): boolean {
  const normalized = normalizeHostname(hostname);
  const family = isIP(normalized);
  if (family === 4) return isPrivateIpv4(normalized);
  if (family === 6) return isPrivateIpv6(normalized);
  return false;
}

function isUnsafeResolvedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return isPrivateIpv4(address);
  if (family === 6) return isPrivateIpv6(address);
  return false;
}

function applyHostFilters(hostname: string, cfg: UrlPolicyConfig): void {
  if (cfg.blockedHosts?.some((pattern) => matchesHostPattern(hostname, pattern))) {
    throw new Error(`deal-hunter: blocked URL host "${hostname}" by blockedHosts policy`);
  }
  if (cfg.allowedHosts?.length && !cfg.allowedHosts.some((pattern) => matchesHostPattern(hostname, pattern))) {
    throw new Error(`deal-hunter: URL host "${hostname}" is not in allowedHosts policy`);
  }
}

/**
 * Validate a target URL before any network access.
 * This blocks localhost and private-network literals by default.
 */
export function validateTargetUrl(url: string, cfg: UrlPolicyConfig = {}): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`deal-hunter: invalid URL "${url}"`);
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`deal-hunter: unsupported URL scheme "${parsed.protocol}"`);
  }

  const hostname = normalizeHostname(parsed.hostname);
  if (!hostname) {
    throw new Error(`deal-hunter: URL is missing a hostname: "${url}"`);
  }

  applyHostFilters(hostname, cfg);

  if (isLocalHostname(hostname)) {
    throw new Error(`deal-hunter: blocked local hostname "${hostname}"`);
  }

  if (isUnsafeIpLiteral(hostname)) {
    throw new Error(`deal-hunter: blocked private or non-public IP target "${hostname}"`);
  }

  return parsed;
}

export async function assertPublicHostnameResolution(
  hostname: string,
  resolver: (hostname: string) => Promise<Array<{ address: string }>> = (input) =>
    lookup(input, { all: true, verbatim: true }),
): Promise<void> {
  const normalized = normalizeHostname(hostname);
  if (!normalized || isIP(normalized)) return;

  let records: Array<{ address: string }>;
  try {
    records = await resolver(normalized);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`deal-hunter: could not resolve host "${normalized}": ${message}`);
  }

  if (!records.length) {
    throw new Error(`deal-hunter: host "${normalized}" did not resolve to any address`);
  }

  const blocked = records.find((record) => isUnsafeResolvedAddress(record.address));
  if (blocked) {
    throw new Error(
      `deal-hunter: blocked host "${normalized}" because it resolves to private or non-public IP "${blocked.address}"`,
    );
  }
}
