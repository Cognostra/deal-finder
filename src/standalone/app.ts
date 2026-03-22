import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import { saveStore } from "../lib/store.js";
import type { ImportedWatchInput } from "../lib/store.js";
import type { ResolvedStandaloneConfig } from "./config.js";
import { createStandaloneRuntime } from "./runtime.js";

class HttpError extends Error {
  statusCode: number;
  code: string;
  details?: unknown;

  constructor(statusCode: number, code: string, message: string, details?: unknown) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

function sendError(reply: FastifyReply, statusCode: number, code: string, message: string, details?: unknown) {
  return reply.code(statusCode).send({
    ok: false,
    error: {
      code,
      message,
      ...(details !== undefined ? { details } : {}),
    },
  });
}

function requireObject(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "validation_error", message);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new HttpError(400, "validation_error", `Field "${field}" must be a non-empty string.`);
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && !Number.isNaN(value) ? value : undefined;
}

function optionalStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : undefined;
}

function toBooleanQuery(value: unknown): boolean | undefined {
  if (value === undefined) return undefined;
  if (value === "true" || value === "1" || value === true) return true;
  if (value === "false" || value === "0" || value === false) return false;
  throw new HttpError(400, "validation_error", "Boolean query parameters must be true/false or 1/0.");
}

function mapError(error: unknown): HttpError {
  if (error instanceof HttpError) return error;
  if (error instanceof Error) {
    if (/unknown saved view/i.test(error.message) || /watch not found/i.test(error.message)) {
      return new HttpError(404, "not_found", error.message);
    }
    return new HttpError(400, "bad_request", error.message);
  }
  return new HttpError(500, "internal_error", "Unexpected error");
}

export async function createStandaloneApp(config: ResolvedStandaloneConfig): Promise<FastifyInstance> {
  const app = Fastify({ logger: config.logRequests });
  const runtime = createStandaloneRuntime(config);

  app.addHook("onRequest", async (request, reply) => {
    if (!config.authToken) return;
    if (!request.url.startsWith("/api/")) return;
    if (request.headers.authorization !== `Bearer ${config.authToken}`) {
      return sendError(reply, 401, "unauthorized", "Missing or invalid bearer token.");
    }
  });

  app.setErrorHandler((error, _request, reply) => {
    const mapped = mapError(error);
    return sendError(reply, mapped.statusCode, mapped.code, mapped.message, mapped.details);
  });

  app.setNotFoundHandler((_request, reply) => sendError(reply, 404, "not_found", "Route not found."));

  app.get("/health/live", async () => ({ ok: true, status: "live" }));

  app.get("/health/ready", async () => {
    const inspection = await runtime.maintenance.inspect();
    return {
      ok: true,
      status: "ready",
      bind: { host: config.host, port: config.port },
      auth: { enabled: Boolean(config.authToken) },
      store: {
        path: config.deal.storePath,
        watchCount: inspection.store.watches.length,
        savedViewCount: inspection.store.savedViews.length,
        recovered: inspection.recovered,
        warnings: inspection.warnings,
      },
    };
  });

  app.get("/api/v1/system/policy", async () => ({
    ok: true,
    standalone: {
      host: config.host,
      port: config.port,
      authEnabled: Boolean(config.authToken),
    },
    deal: {
      storePath: config.deal.storePath,
      fetcher: config.deal.fetcher,
      llmReview: config.deal.llmReview,
      discovery: config.deal.discovery,
    },
  }));

  app.get("/api/v1/watches", async (request) => {
    const query = request.query as Record<string, unknown>;
    const includeDisabled = toBooleanQuery(query.includeDisabled);
    const watches = await runtime.services.watch.list(includeDisabled === true);
    return { ok: true, count: watches.length, watches };
  });

  app.post("/api/v1/watches", async (request, reply) => {
    const body = requireObject(request.body, "Request body must be an object.");
    const watch = await runtime.services.watch.add(
      {
        url: requireString(body.url, "url"),
        label: optionalString(body.label),
        group: optionalString(body.group),
        tags: optionalStringArray(body.tags),
        maxPrice: optionalNumber(body.maxPrice),
        percentDrop: optionalNumber(body.percentDrop),
        keywords: optionalStringArray(body.keywords),
        checkIntervalHint: optionalString(body.checkIntervalHint),
        enabled: optionalBoolean(body.enabled),
      },
      config.deal,
    );
    return reply.code(201).send({ ok: true, watch });
  });

  app.patch("/api/v1/watches/:watchId", async (request) => {
    const body = requireObject(request.body, "Request body must be an object.");
    const watchId = requireString((request.params as Record<string, unknown>).watchId, "watchId");
    const watch = await runtime.services.watch.update(
      watchId,
      {
        url: optionalString(body.url),
        label: Object.hasOwn(body, "label") ? (body.label === null ? null : optionalString(body.label)) : undefined,
        group: Object.hasOwn(body, "group") ? (body.group === null ? null : optionalString(body.group)) : undefined,
        tags: Object.hasOwn(body, "tags") ? (body.tags === null ? null : optionalStringArray(body.tags)) : undefined,
        maxPrice: Object.hasOwn(body, "maxPrice") ? (body.maxPrice === null ? null : optionalNumber(body.maxPrice)) : undefined,
        percentDrop: Object.hasOwn(body, "percentDrop") ? (body.percentDrop === null ? null : optionalNumber(body.percentDrop)) : undefined,
        keywords: Object.hasOwn(body, "keywords") ? (body.keywords === null ? null : optionalStringArray(body.keywords)) : undefined,
        checkIntervalHint: Object.hasOwn(body, "checkIntervalHint")
          ? (body.checkIntervalHint === null ? null : optionalString(body.checkIntervalHint))
          : undefined,
        enabled: optionalBoolean(body.enabled),
        clearLastSnapshot: optionalBoolean(body.clearLastSnapshot),
      },
      config.deal,
    );
    if (!watch) {
      throw new HttpError(404, "not_found", "watch not found");
    }
    return { ok: true, watch };
  });

  app.delete("/api/v1/watches/:watchId", async (request) => {
    const watchId = requireString((request.params as Record<string, unknown>).watchId, "watchId");
    const removed = await runtime.services.watch.remove(watchId);
    if (!removed) {
      throw new HttpError(404, "not_found", "watch not found");
    }
    return { ok: true, removed };
  });

  app.get("/api/v1/views", async () => {
    const savedViews = await runtime.services.savedViews.list();
    return { ok: true, count: savedViews.length, savedViews };
  });

  app.post("/api/v1/views", async (request, reply) => {
    const body = requireObject(request.body, "Request body must be an object.");
    const selector = requireObject(body.selector ?? {}, 'Field "selector" must be an object.');
    const savedView = await runtime.services.savedViews.create({
      name: requireString(body.name, "name"),
      description: optionalString(body.description),
      selector: {
        query: optionalString(selector.query),
        enabled: optionalBoolean(selector.enabled),
        hasSnapshot: optionalBoolean(selector.hasSnapshot),
        hasSignals: optionalBoolean(selector.hasSignals),
        tag: optionalString(selector.tag),
        group: optionalString(selector.group),
        sortBy:
          selector.sortBy === "createdAt" || selector.sortBy === "label" || selector.sortBy === "price"
            ? selector.sortBy
            : undefined,
        descending: optionalBoolean(selector.descending),
        limit: typeof selector.limit === "number" ? selector.limit : undefined,
      },
    });
    return reply.code(201).send({ ok: true, savedView });
  });

  app.get("/api/v1/views/:savedViewId", async (request) => {
    const savedViewId = requireString((request.params as Record<string, unknown>).savedViewId, "savedViewId");
    const selection = await runtime.services.savedViews.run(savedViewId);
    return { ok: true, savedView: selection.savedView, watchCount: selection.watches.length, watches: selection.watches };
  });

  app.patch("/api/v1/views/:savedViewId", async (request) => {
    const body = requireObject(request.body, "Request body must be an object.");
    const savedViewId = requireString((request.params as Record<string, unknown>).savedViewId, "savedViewId");
    const selector = body.selector && body.selector !== null ? requireObject(body.selector, 'Field "selector" must be an object.') : undefined;
    const savedView = await runtime.services.savedViews.update(savedViewId, {
      name: optionalString(body.name),
      description: Object.hasOwn(body, "description") ? (body.description === null ? null : optionalString(body.description)) : undefined,
      selector: selector
        ? {
            query: optionalString(selector.query),
            enabled: optionalBoolean(selector.enabled),
            hasSnapshot: optionalBoolean(selector.hasSnapshot),
            hasSignals: optionalBoolean(selector.hasSignals),
            tag: optionalString(selector.tag),
            group: optionalString(selector.group),
            sortBy:
              selector.sortBy === "createdAt" || selector.sortBy === "label" || selector.sortBy === "price"
                ? selector.sortBy
                : undefined,
            descending: optionalBoolean(selector.descending),
            limit: typeof selector.limit === "number" ? selector.limit : undefined,
          }
        : undefined,
    });
    return { ok: true, savedView };
  });

  app.delete("/api/v1/views/:savedViewId", async (request) => {
    const savedViewId = requireString((request.params as Record<string, unknown>).savedViewId, "savedViewId");
    const removed = await runtime.services.savedViews.remove(savedViewId);
    return { ok: true, removed };
  });

  app.post("/api/v1/scans", async (request) => {
    const body = request.body ? requireObject(request.body, "Request body must be an object.") : {};
    const watchIds = optionalStringArray(body.watchIds);
    const commit = body.commit !== false;
    const baseStore = await runtime.repositories.watchRepository.loadStore();
    const results = await runtime.services.scanExecution.run({
      cfg: config.deal,
      store: structuredClone(baseStore),
      watchIds,
    });
    let commitSummary = null;
    if (commit) {
      const liveStore = await runtime.repositories.watchRepository.loadStore();
      commitSummary = runtime.services.scanCommit.merge(liveStore, results, config.deal);
      await saveStore(config.deal.storePath, liveStore);
    }
    return { ok: true, watchCount: results.length, commit, commitSummary, results };
  });

  app.get("/api/v1/discovery/policy", async () => ({
    ok: true,
    ...runtime.services.discovery.describePolicy(config.deal),
  }));

  app.get("/api/v1/reviews/policy", async () => ({
    ok: true,
    ...runtime.services.review.describePolicy(config.deal),
  }));

  app.get("/api/v1/reports/summary", async (request) => {
    const query = request.query as Record<string, unknown>;
    const savedViewId = optionalString(query.savedViewId);
    return {
      ok: true,
      report: savedViewId
        ? await runtime.services.reporting.getViewReport({ savedViewId })
        : await runtime.services.reporting.getStoreReport(),
    };
  });

  return app;
}
