import { describe, expect, it } from "vitest";
import { assertPublicHostnameResolution, validateTargetUrl } from "./url-policy.js";

describe("validateTargetUrl", () => {
  it("accepts and normalizes a public https URL", () => {
    const url = validateTargetUrl("https://Example.com/deals?q=1");
    expect(url.toString()).toBe("https://example.com/deals?q=1");
  });

  it("rejects unsupported schemes", () => {
    expect(() => validateTargetUrl("file:///etc/passwd")).toThrow(/unsupported URL scheme/i);
  });

  it("rejects localhost", () => {
    expect(() => validateTargetUrl("http://localhost:8080/test")).toThrow(/blocked local hostname/i);
  });

  it("rejects private IPv4 literals", () => {
    expect(() => validateTargetUrl("http://192.168.1.10/item")).toThrow(/blocked private or non-public IP target/i);
  });

  it("rejects loopback IPv6 literals", () => {
    expect(() => validateTargetUrl("http://[::1]/item")).toThrow(/blocked private or non-public IP target/i);
  });

  it("rejects IPv4-mapped loopback IPv6 literals", () => {
    expect(() => validateTargetUrl("http://[::ffff:127.0.0.1]/item")).toThrow(/blocked private or non-public IP target/i);
  });

  it("enforces blockedHosts patterns", () => {
    expect(() =>
      validateTargetUrl("https://shop.example.com/item", { blockedHosts: ["*.example.com"] }),
    ).toThrow(/blockedHosts policy/i);
  });

  it("enforces allowedHosts patterns", () => {
    expect(() =>
      validateTargetUrl("https://shop.other.com/item", { allowedHosts: ["*.example.com"] }),
    ).toThrow(/allowedHosts policy/i);
  });

  it("allows hosts that match the allowlist", () => {
    const url = validateTargetUrl("https://deals.example.com/item", {
      allowedHosts: ["*.example.com"],
    });
    expect(url.hostname).toBe("deals.example.com");
  });
});

describe("assertPublicHostnameResolution", () => {
  it("allows a hostname that resolves only to public IPs", async () => {
    await expect(
      assertPublicHostnameResolution("example.com", async () => [{ address: "93.184.216.34" }]),
    ).resolves.toBeUndefined();
  });

  it("rejects a hostname that resolves to loopback", async () => {
    await expect(
      assertPublicHostnameResolution("evil.test", async () => [{ address: "127.0.0.1" }]),
    ).rejects.toThrow(/resolves to private or non-public IP/i);
  });

  it("rejects a hostname that resolves to RFC1918 space", async () => {
    await expect(
      assertPublicHostnameResolution("evil.test", async () => [{ address: "10.0.0.5" }]),
    ).rejects.toThrow(/resolves to private or non-public IP/i);
  });
});
