import { describe, expect, it } from "vitest";
import { resolveStandaloneConfig } from "./config.js";

describe("standalone config", () => {
  it("defaults to localhost-only no-auth mode", () => {
    const config = resolveStandaloneConfig({}, {
      cwd: "/tmp/work",
      homeDir: "/tmp/home",
    });

    expect(config.host).toBe("127.0.0.1");
    expect(config.port).toBe(3210);
    expect(config.authToken).toBeUndefined();
    expect(config.deal.storePath).toBe("/tmp/home/.deal-hunter-standalone/store.json");
  });

  it("requires a token for non-localhost binds", () => {
    expect(() => resolveStandaloneConfig({ host: "0.0.0.0" })).toThrow(/authToken is required/i);
  });

  it("supports token-protected non-localhost binding", () => {
    const config = resolveStandaloneConfig({
      host: "0.0.0.0",
      port: 8080,
      authToken: "secret",
      storePath: "./data/store.json",
    }, {
      cwd: "/srv/deal-hunter",
      homeDir: "/tmp/home",
    });

    expect(config.host).toBe("0.0.0.0");
    expect(config.port).toBe(8080);
    expect(config.authToken).toBe("secret");
    expect(config.deal.storePath).toBe("/srv/deal-hunter/data/store.json");
  });
});
