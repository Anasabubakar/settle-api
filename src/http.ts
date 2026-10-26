import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Config } from "./config.ts";
import { ApiError, badRequest, notFound } from "./errors.ts";
import type { HandlerResult, SettlementService } from "./service.ts";

const MAX_BODY_BYTES = 64 * 1024;

interface Route {
  method: string;
  /** The path as the OpenAPI contract writes it. A test keeps the two in step. */
  doc: string;
  pattern: RegExp;
  handler: (context: RequestContext) => Promise<HandlerResult> | HandlerResult;
}

interface RequestContext {
  params: string[];
  body: unknown;
  idempotencyKey: string | undefined;
}

export interface AppOptions {
  config: Config;
  service: SettlementService;
  log?: (event: Record<string, unknown>) => void;
  now?: () => number;
}

/**
 * The HTTP surface, on Node's own `http` module: a small router, a body limit,
 * strict JSON handling, a per-client rate limit, an explicit CORS allow-list and
 * one error shape. Kept dependency-free on purpose — a payment boundary should
 * have as little third-party code in front of it as possible.
 */
export type AppHandler = ((req: IncomingMessage, res: ServerResponse) => Promise<void>) & { routes: readonly string[] };

export function createApp(options: AppOptions): AppHandler {
  const { config, service } = options;
  const log = options.log ?? (() => {});
  const now = options.now ?? Date.now;
  const windows = new Map<string, { count: number; resetAt: number }>();

  const requireKey = (context: RequestContext): string => {
    if (!context.idempotencyKey) {
      throw badRequest("idempotency_key_required", "This request needs an Idempotency-Key header so a retry can never act twice.");
    }
    return context.idempotencyKey;
  };

  const routes: Route[] = [
    {
      method: "GET",
      doc: "/healthz",
      pattern: /^\/healthz$/,
      handler: () => ({ status: 200, body: { status: "ok", network: config.network, ledger: service.ledgerStatus() } }),
    },
    { method: "GET", doc: "/v1/config", pattern: /^\/v1\/config$/, handler: () => ({ status: 200, body: service.config_() }) },
    { method: "GET", doc: "/v1/bills", pattern: /^\/v1\/bills$/, handler: () => ({ status: 200, body: { bills: service.listBills() } }) },
    { method: "GET", doc: "/v1/bills/{billId}", pattern: /^\/v1\/bills\/([^/]+)$/, handler: ({ params }) => ({ status: 200, body: service.billView(params[0]!) }) },
    { method: "POST", doc: "/v1/quotes", pattern: /^\/v1\/quotes$/, handler: (context) => service.createQuote(context.body, requireKey(context)) },
    { method: "GET", doc: "/v1/quotes/{quoteId}", pattern: /^\/v1\/quotes\/([^/]+)$/, handler: ({ params }) => ({ status: 200, body: service.getQuote(params[0]!) }) },
    { method: "POST", doc: "/v1/payments", pattern: /^\/v1\/payments$/, handler: (context) => service.submitPayment(context.body, requireKey(context)) },
    {
      method: "GET",
      doc: "/v1/payments/{paymentId}",
      pattern: /^\/v1\/payments\/([^/]+)$/,
      handler: async ({ params }) => ({ status: 200, body: await service.getPayment(params[0]!) }),
    },
    { method: "GET", doc: "/v1/receipts/{receiptId}", pattern: /^\/v1\/receipts\/([^/]+)$/, handler: ({ params }) => ({ status: 200, body: service.getReceipt(params[0]!) }) },
    { method: "GET", doc: "/v1/ledger", pattern: /^\/v1\/ledger$/, handler: () => ({ status: 200, body: service.ledgerStatus() }) },
  ];

  function clientKey(req: IncomingMessage): string {
    // Deliberately the socket address only: X-Forwarded-For is client-controlled
    // unless a trusted proxy is in front, and this service does not assume one.
    return req.socket.remoteAddress ?? "unknown";
  }

  function rateLimited(req: IncomingMessage): number | null {
    const nowMs = now();
    if (windows.size > 10_000) {
      for (const [key, entry] of windows) if (entry.resetAt <= nowMs) windows.delete(key);
    }
    const key = clientKey(req);
    const entry = windows.get(key);
    if (!entry || entry.resetAt <= nowMs) {
      windows.set(key, { count: 1, resetAt: nowMs + 60_000 });
      return null;
    }
    entry.count += 1;
    return entry.count > config.rateLimitPerMinute ? Math.ceil((entry.resetAt - nowMs) / 1000) : null;
  }

  async function readJson(req: IncomingMessage): Promise<unknown> {
    const type = (req.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
    if (type !== "application/json") throw new ApiError(415, "unsupported_media_type", "Send the body as application/json.");
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      const buffer = chunk as Buffer;
      size += buffer.length;
      if (size > MAX_BODY_BYTES) throw new ApiError(413, "payload_too_large", "The request body is too large.");
      chunks.push(buffer);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      throw badRequest("invalid_json", "The request body is not valid JSON.");
    }
  }

  function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string>): void {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "content-length": Buffer.byteLength(payload),
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      ...headers,
    });
    res.end(payload);
  }

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const requestId = randomUUID();
    const started = now();
    const headers: Record<string, string> = { "x-request-id": requestId };
    let status = 500;
    const url = new URL(req.url ?? "/", "http://localhost");
    const method = req.method ?? "GET";

    const origin = req.headers.origin;
    if (origin && config.corsOrigins.includes(origin)) {
      headers["access-control-allow-origin"] = origin;
      headers.vary = "Origin";
      headers["access-control-allow-headers"] = "content-type, idempotency-key";
      headers["access-control-allow-methods"] = "GET, POST, OPTIONS";
      headers["access-control-max-age"] = "600";
    }

    try {
      if (method === "OPTIONS") {
        status = 204;
        res.writeHead(204, { ...headers, "content-length": 0 });
        res.end();
        return;
      }

      const wait = rateLimited(req);
      if (wait !== null) {
        headers["retry-after"] = String(wait);
        throw new ApiError(429, "rate_limited", "Too many requests. Slow down and retry shortly.");
      }

      const matching = routes.filter((route) => route.pattern.test(url.pathname));
      if (matching.length === 0) throw notFound("not_found", "No such endpoint.");
      const route = matching.find((candidate) => candidate.method === method);
      if (!route) {
        headers.allow = matching.map((candidate) => candidate.method).join(", ");
        throw new ApiError(405, "method_not_allowed", "That method is not allowed here.");
      }

      const params = route.pattern.exec(url.pathname)!.slice(1).map((value) => {
        try {
          return decodeURIComponent(value);
        } catch {
          throw badRequest("invalid_path", "The path contains an invalid escape sequence.");
        }
      });
      const body = method === "POST" ? await readJson(req) : undefined;
      const key = req.headers["idempotency-key"];
      const result = await route.handler({ params, body, idempotencyKey: typeof key === "string" ? key : undefined });
      status = result.status;
      if (result.replay) headers["idempotent-replay"] = "true";
      send(res, result.status, result.body, headers);
    } catch (error) {
      if (error instanceof ApiError) {
        status = error.status;
        send(res, error.status, { error: { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}), requestId } }, headers);
      } else {
        status = 500;
        log({ event: "unhandled_error", requestId, message: error instanceof Error ? error.message : "unknown" });
        send(res, 500, { error: { code: "internal_error", message: "Something went wrong on our side.", requestId } }, headers);
      }
    } finally {
      log({ event: "request", requestId, method, path: url.pathname, status, ms: now() - started });
    }
  };
  return Object.assign(handle, { routes: routes.map((route) => `${route.method} ${route.doc}`) });
}
