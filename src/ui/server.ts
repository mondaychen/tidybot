import { randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ORPCError, ValidationError } from "@orpc/server";
import { BodyLimitPlugin, RPCHandler } from "@orpc/server/node";
import mime from "mime";
import { ZodError, z } from "zod";
import { TidyError } from "../errors.js";
import { isWithin } from "../paths.js";
import { recoverMoves } from "../store/operations.js";
import { router } from "./router.js";

/**
 * The local server behind `tidybot ui`: the oRPC router in ./router.ts under /api/, plus the built
 * web frontend. It moves files, so it only answers requests that come from its own page:
 * - It listens on 127.0.0.1, and checks the Host header, so a DNS-rebinding page can't reach it.
 * - API calls need the session token (printed in the URL) as `Authorization: Bearer <token>` and,
 *   when the browser sends one, a matching Origin. Other sites can't send that header without a
 *   CORS preflight, which this server never allows.
 * Calls run one at a time, because most stores assume one writer.
 */

const MAX_BODY = 1024 * 1024;

/** Tried first when no port is given. If it is busy, any free port is used instead. */
export const DEFAULT_PORT = 4477;

export interface UiServer {
  url: string;
  port: number;
  close: () => Promise<void>;
}

/** The built frontend: dist/web next to dist/ui, or the repo's dist/web when running from src/. */
function defaultStaticDir(): string | undefined {
  const candidates = ["../web", "../../dist/web"].map((rel) => fileURLToPath(new URL(rel, import.meta.url)));
  return candidates.find((dir) => fs.existsSync(path.join(dir, "index.html")));
}

const sameToken = (given: string | undefined, token: string) =>
  !!given && given.length === token.length && timingSafeEqual(Buffer.from(given), Buffer.from(token));

/** An error reply in oRPC's format, so the client shows its message. */
function fail(res: http.ServerResponse, status: number, code: string, message: string): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify({ json: new ORPCError(code, { status, message }).toJSON() }));
}

/** HTTP status for an expected failure. */
function statusFor(code: string): number {
  if (code === "not_found") return 404;
  if (code === "busy" || code === "recovery_required") return 409;
  return 400;
}

/** Input problems, one per line, with where they are. */
function describeIssues(issues: ValidationError["issues"]): string {
  return issues
    .map((i) => {
      const at = (i.path ?? []).map((p) => String(typeof p === "object" ? p.key : p)).join(".");
      return at ? `${i.message} (at ${at})` : i.message;
    })
    .join("\n");
}

/** What the client gets for an error: tidybot's own code and message, as the CLI prints them. */
function toClientError(err: unknown): ORPCError<string, unknown> {
  if (err instanceof ORPCError) {
    if (err.code === "BAD_REQUEST" && err.cause instanceof ValidationError) {
      return new ORPCError("invalid_input", { status: 400, message: describeIssues(err.cause.issues) });
    }
    return err;
  }
  if (err instanceof TidyError) return new ORPCError(err.code, { status: statusFor(err.code), message: err.message });
  // Stores check what they save with zod, too (a place with no name, say).
  if (err instanceof ZodError) return new ORPCError("invalid_input", { status: 400, message: z.prettifyError(err) });
  return new ORPCError("internal", { status: 500, message: err instanceof Error ? err.message : String(err) });
}

const handler = new RPCHandler(router, {
  plugins: [new BodyLimitPlugin({ maxBodySize: MAX_BODY })],
  clientInterceptors: [
    async ({ next }) => {
      try {
        return await next();
      } catch (err) {
        throw toClientError(err);
      }
    },
  ],
});

function listen(server: http.Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error) => reject(err);
    server.once("error", onError);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", onError);
      resolve();
    });
  });
}

const inUse = (err: unknown) => err instanceof Error && "code" in err && err.code === "EADDRINUSE";

/** With `port`, use exactly that port (0 = any free port). Without it, DEFAULT_PORT or a free one. */
export async function startUiServer(opts: { port?: number; token?: string; staticDir?: string }): Promise<UiServer> {
  const token = opts.token || randomBytes(24).toString("base64url");
  const staticDir = opts.staticDir ?? defaultStaticDir();
  let port = opts.port ?? DEFAULT_PORT;
  let queue: Promise<unknown> = Promise.resolve();

  /** Run calls one after another, in the order they came in. */
  function serialized<T>(fn: () => Promise<T>): Promise<T> {
    const run = queue.then(fn, fn);
    queue = run.catch(() => undefined);
    return run;
  }

  async function api(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (req.method !== "POST") return fail(res, 405, "method_not_allowed", "Use POST.");
    const origin = req.headers.origin;
    if (origin !== undefined && origin !== `http://${req.headers.host}`) return fail(res, 403, "forbidden", "Cross-origin requests are not allowed.");
    const given = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1];
    if (!sameToken(given, token)) return fail(res, 401, "unauthorized", "Missing or wrong session key. Open the link that `tidybot ui` printed.");
    try {
      const { matched } = await serialized(async () => {
        try {
          recoverMoves();
        } catch (err) {
          // Only moves need a clean slate; they check again and refuse to start.
          if (!(err instanceof TidyError && err.code === "recovery_required")) throw err;
        }
        return handler.handle(req, res, { prefix: "/api" });
      });
      if (!matched) fail(res, 404, "not_found", "No such procedure.");
    } catch (err) {
      if (!res.headersSent) fail(res, 500, "internal", err instanceof Error ? err.message : String(err));
    }
  }

  function serveStatic(req: http.IncomingMessage, res: http.ServerResponse, pathname: string): void {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405).end();
      return;
    }
    if (!staticDir) {
      res.writeHead(503, { "content-type": "text/plain; charset=utf-8" });
      res.end("The tidybot web frontend isn't built. Run `pnpm build` in the tidybot repo, or use the Vite dev server (see README).");
      return;
    }
    const wanted = path.join(staticDir, decodeURIComponent(pathname));
    const isFile = isWithin(wanted, staticDir) && fs.statSync(wanted, { throwIfNoEntry: false })?.isFile();
    // Any other path is a page of the single-page app.
    const file = isFile ? wanted : path.join(staticDir, "index.html");
    if (!isFile && path.extname(pathname)) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, {
      "content-type": mime.getType(file) ?? "application/octet-stream",
      // Built assets have content hashes in their names; the page itself must not be cached.
      "cache-control": file.includes(`${path.sep}assets${path.sep}`) ? "public, max-age=31536000, immutable" : "no-cache",
      "content-security-policy": "default-src 'self'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    });
    if (req.method === "HEAD") res.end();
    else fs.createReadStream(file).pipe(res);
  }

  const server = http.createServer((req, res) => {
    const host = req.headers.host;
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
      res.writeHead(403, { "content-type": "text/plain; charset=utf-8" }).end("Forbidden host.");
      return;
    }
    let pathname: string;
    try {
      pathname = new URL(req.url ?? "/", `http://${host}`).pathname;
      decodeURIComponent(pathname);
    } catch {
      res.writeHead(400).end();
      return;
    }
    if (pathname.startsWith("/api/")) void api(req, res);
    else serveStatic(req, res, pathname);
  });

  try {
    await listen(server, port);
  } catch (err) {
    if (!inUse(err)) throw err;
    if (opts.port !== undefined) throw new TidyError(`Port ${port} is in use. Pick another with --port, or leave out --port to use a free one.`, "busy");
    await listen(server, 0);
  }
  port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/#token=${token}`,
    port,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
        server.closeAllConnections();
      }),
  };
}
