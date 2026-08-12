import { readFile } from "node:fs/promises";
import { join } from "node:path";

import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";

import {
  ProviderPulseApplication,
  UnknownConfiguredTargetError,
} from "./application.js";

export interface ServerOptions {
  publicDirectory: string;
  host: "127.0.0.1" | "::1" | "localhost";
  port: number;
}

export async function buildServer(
  application: ProviderPulseApplication,
  options: ServerOptions,
): Promise<FastifyInstance> {
  const [index, stylesheet, script] = await Promise.all([
    readFile(join(options.publicDirectory, "index.html")),
    readFile(join(options.publicDirectory, "app.css")),
    readFile(join(options.publicDirectory, "app.js")),
  ]);
  const server = Fastify({ logger: false });
  const authority = formatAuthority(options.host, options.port);
  const origin = `http://${authority}`;

  server.addHook("onRequest", async (request, reply) => {
    if (request.headers.host !== authority) {
      return reply.code(403).send({
        error: {
          code: "invalid_host",
          message: "Request Host does not match the configured local authority",
        },
      });
    }
    if (
      request.method === "POST" &&
      (request.headers.origin !== origin || request.headers["x-provider-pulse-action"] !== "1")
    ) {
      return reply.code(403).send({
        error: {
          code: "invalid_action_origin",
          message: "Action requests require the configured local origin",
        },
      });
    }
  });

  server.addHook("onSend", async (_request, reply, payload) => {
    reply.headers({
      "content-security-policy": "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      "x-frame-options": "DENY",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    });
    return payload;
  });

  server.get("/api/health", async (_request, reply) => {
    const status = application.getStatus();
    return reply.header("cache-control", "no-store").send({
      status: "ok",
      health: status.health,
      generatedAt: status.generatedAt,
    });
  });
  server.get("/api/status", async (_request, reply) => {
    return reply.header("cache-control", "no-store").send(application.getStatus());
  });

  server.post<{ Params: { accountId: string } }>("/api/accounts/:accountId/check", async (request, reply) => {
    try {
      return reply.code(202).send(application.checkUsage(request.params.accountId));
    } catch (error: unknown) {
      return actionError(reply, error);
    }
  });
  server.post("/api/check-all", async (_request, reply) => {
    return reply.code(202).send({ receipts: application.checkAll() });
  });
  server.post<{ Params: { heartbeatId: string } }>("/api/heartbeats/:heartbeatId/run", async (request, reply) => {
    try {
      return reply.code(202).send(application.runHeartbeat(request.params.heartbeatId));
    } catch (error: unknown) {
      return actionError(reply, error);
    }
  });
  server.post("/api/heartbeat-all", async (_request, reply) => {
    return reply.code(202).send({ receipts: application.heartbeatAll() });
  });

  server.get("/", async (_request, reply) => reply.type("text/html; charset=utf-8").send(index));
  server.get("/app.css", async (_request, reply) => reply.type("text/css; charset=utf-8").send(stylesheet));
  server.get("/app.js", async (_request, reply) => reply.type("text/javascript; charset=utf-8").send(script));

  return server;
}

function actionError(reply: FastifyReply, error: unknown) {
  if (error instanceof UnknownConfiguredTargetError) {
    return reply.code(404).send({ error: { code: `${error.kind}_not_found`, message: error.message } });
  }
  throw error;
}

function formatAuthority(host: ServerOptions["host"], port: number): string {
  return host === "::1" ? `[${host}]:${port}` : `${host}:${port}`;
}
