import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { createStandaloneApp } from "./app.js";
import { resolveStandaloneConfig } from "./config.js";

let tempDirs: string[] = [];

async function makeConfig(overrides: Record<string, unknown> = {}) {
  const dir = await mkdtemp(join(tmpdir(), "deal-hunter-standalone-"));
  tempDirs.push(dir);
  return resolveStandaloneConfig({
    storePath: join(dir, "store.json"),
    ...overrides,
  });
}

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs = [];
});

describe("standalone app", () => {
  it("serves liveness and readiness endpoints", async () => {
    const app = await createStandaloneApp(await makeConfig());
    const live = await app.inject({ method: "GET", url: "/health/live" });
    const ready = await app.inject({ method: "GET", url: "/health/ready" });

    expect(live.statusCode).toBe(200);
    expect(live.json()).toEqual({ ok: true, status: "live" });
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toMatchObject({
      ok: true,
      status: "ready",
      auth: { enabled: false },
      store: { watchCount: 0, savedViewCount: 0, recovered: false },
    });
    await app.close();
  });

  it("supports watch and saved-view lifecycle routes", async () => {
    const app = await createStandaloneApp(await makeConfig());

    const addWatch = await app.inject({
      method: "POST",
      url: "/api/v1/watches",
      payload: {
        url: "https://shop.test/gpu",
        label: "GPU Watch",
        tags: ["gpu"],
      },
    });
    expect(addWatch.statusCode).toBe(201);
    const watch = addWatch.json().watch;

    const list = await app.inject({ method: "GET", url: "/api/v1/watches" });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toMatchObject({ ok: true, count: 1 });

    const createView = await app.inject({
      method: "POST",
      url: "/api/v1/views",
      payload: {
        name: "GPUs",
        selector: { query: "gpu" },
      },
    });
    expect(createView.statusCode).toBe(201);
    const savedView = createView.json().savedView;

    const runView = await app.inject({ method: "GET", url: `/api/v1/views/${savedView.id}` });
    expect(runView.statusCode).toBe(200);
    expect(runView.json()).toMatchObject({
      ok: true,
      watchCount: 1,
      watches: [{ id: watch.id }],
    });
    await app.close();
  });

  it("exposes scans, reports, discovery, review, and system routes", async () => {
    const app = await createStandaloneApp(await makeConfig());

    const scan = await app.inject({ method: "POST", url: "/api/v1/scans", payload: {} });
    const report = await app.inject({ method: "GET", url: "/api/v1/reports/summary" });
    const discovery = await app.inject({ method: "GET", url: "/api/v1/discovery/policy" });
    const review = await app.inject({ method: "GET", url: "/api/v1/reviews/policy" });
    const system = await app.inject({ method: "GET", url: "/api/v1/system/policy" });

    expect(scan.statusCode).toBe(200);
    expect(scan.json()).toMatchObject({ ok: true, watchCount: 0, results: [] });
    expect(report.statusCode).toBe(200);
    expect(report.json()).toMatchObject({ ok: true, report: { total: 0, enabled: 0, disabled: 0 } });
    expect(discovery.statusCode).toBe(200);
    expect(discovery.json()).toMatchObject({ ok: true, enabled: false, provider: "off" });
    expect(review.statusCode).toBe(200);
    expect(review.json()).toMatchObject({ ok: true, mode: "off" });
    expect(system.statusCode).toBe(200);
    expect(system.json()).toMatchObject({
      ok: true,
      standalone: { host: "127.0.0.1", port: 3210, authEnabled: false },
    });
    await app.close();
  });

  it("returns canonical error envelopes for auth and validation failures", async () => {
    const app = await createStandaloneApp(await makeConfig({
      host: "0.0.0.0",
      authToken: "secret",
    }));

    const unauthorized = await app.inject({ method: "GET", url: "/api/v1/system/policy" });
    expect(unauthorized.statusCode).toBe(401);
    expect(unauthorized.json()).toMatchObject({
      ok: false,
      error: { code: "unauthorized" },
    });

    const validation = await app.inject({
      method: "POST",
      url: "/api/v1/watches",
      headers: { authorization: "Bearer secret" },
      payload: {},
    });
    expect(validation.statusCode).toBe(400);
    expect(validation.json()).toMatchObject({
      ok: false,
      error: { code: "validation_error" },
    });

    const authorized = await app.inject({
      method: "GET",
      url: "/api/v1/system/policy",
      headers: { authorization: "Bearer secret" },
    });
    expect(authorized.statusCode).toBe(200);
    await app.close();
  });
});
