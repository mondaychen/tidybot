import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { beforeEach, describe, expect, it, onTestFinished } from "vitest";
import { propose } from "../src/planner.js";
import { addPlace } from "../src/store/places.js";
import { ORPCError, createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { ContractRouterClient } from "@orpc/contract";
import type { contract } from "../src/ui/contract.js";
import { DEFAULT_PORT, type UiServer, startUiServer } from "../src/ui/server.js";
import { sandbox, write } from "./helpers.js";

const TOKEN = "test-token";

let root: string;
let dl: string;
let server: UiServer;
let api: ContractRouterClient<typeof contract>;

beforeEach(async () => {
  root = sandbox();
  dl = path.join(root, "dl");
  const web = write(path.join(root, "web/index.html"), "<!doctype html><title>tidybot</title>");
  write(path.join(root, "web/assets/app.js"), "console.log(1)");
  server = await startUiServer({ port: 0, token: TOKEN, staticDir: path.dirname(web) });
  api = createORPCClient(new RPCLink({ url: `http://127.0.0.1:${server.port}/api`, headers: { authorization: `Bearer ${TOKEN}` } }));
  onTestFinished(() => server.close());
});

/** A raw request, so tests can send the headers a browser on another site would. */
function request(opts: { method?: string; path: string; headers?: Record<string, string>; body?: string }): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: server.port, method: opts.method ?? "POST", path: opts.path, headers: opts.headers }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c: string) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end(opts.body);
  });
}

const headers = { "content-type": "application/json", authorization: `Bearer ${TOKEN}` };
/** A call's body in oRPC's wire format. */
const body = (input: unknown) => JSON.stringify({ json: input });

/** The error code of a failed call. */
async function codeOf(call: Promise<unknown>): Promise<string> {
  try {
    await call;
  } catch (err) {
    if (err instanceof ORPCError) return err.code;
    throw err;
  }
  throw new Error("expected the call to fail");
}

describe("ui server", () => {
  it("answers its own page only", async () => {
    const b = body(undefined);
    expect((await request({ path: "/api/status", headers, body: b })).status).toBe(200);
    expect((await request({ path: "/api/status", headers: { "content-type": "application/json" }, body: b })).status).toBe(401);
    expect((await request({ path: "/api/status", headers: { ...headers, authorization: "Bearer wrong-token" }, body: b })).status).toBe(401);
    expect((await request({ path: "/api/status", headers: { ...headers, host: "evil.example:80" }, body: b })).status).toBe(403);
    expect((await request({ path: "/api/status", headers: { ...headers, origin: "http://evil.example" }, body: b })).status).toBe(403);
    expect((await request({ path: "/api/status", headers: { ...headers, origin: `http://127.0.0.1:${server.port}` }, body: b })).status).toBe(200);
    expect((await request({ method: "GET", path: "/api/status", headers })).status).toBe(405);
    // Rejections come in oRPC's format, so the client shows the message.
    const wrong = createORPCClient<ContractRouterClient<typeof contract>>(new RPCLink({ url: `http://127.0.0.1:${server.port}/api` }));
    expect(await codeOf(wrong.status())).toBe("unauthorized");
  });

  it("reports unknown procedures and bad input as errors", async () => {
    expect(await request({ path: "/api/nope", headers, body: body({}) })).toMatchObject({ status: 404 });
    expect(await codeOf(api.plans.get({ id: "../config" }))).toBe("invalid_input");
    await expect(api.plans.get({ id: "../config" })).rejects.toThrow("not a plan id (at id)");
    expect(await codeOf(api.plans.get({ id: "p1" }))).toBe("not_found");
    // The store's own checks, too.
    await expect(api.places.add({ name: "", path: "/x", rule: "" })).rejects.toThrow("name is required");
  });

  it("serves the frontend, with the page for any app path", async () => {
    const page = await request({ method: "GET", path: "/plans/p123" });
    expect(page).toMatchObject({ status: 200, body: expect.stringContaining("<title>tidybot</title>") });
    expect((await request({ method: "GET", path: "/assets/app.js" })).body).toBe("console.log(1)");
    expect((await request({ method: "GET", path: "/assets/missing.js" })).status).toBe(404);
    expect((await request({ method: "GET", path: "/../../etc/passwd" })).body).not.toContain("root:");
  });
});

describe("ui server port", () => {
  it("falls back to a free port only when no port was given", async () => {
    // Keep the default port busy (it may be busy already, which is fine).
    const blocker = net.createServer();
    await new Promise<void>((resolve) => {
      blocker.once("error", () => resolve());
      blocker.listen(DEFAULT_PORT, "127.0.0.1", () => resolve());
    });
    onTestFinished(() => new Promise<void>((resolve) => blocker.close(() => resolve())));

    const fallback = await startUiServer({});
    onTestFinished(() => fallback.close());
    expect(fallback.port).not.toBe(DEFAULT_PORT);
    expect(fallback.url).toContain(`:${fallback.port}/`);

    await expect(startUiServer({ port: DEFAULT_PORT })).rejects.toThrow(`Port ${DEFAULT_PORT} is in use`);
  });
});

describe("ui methods", () => {
  it("reviews, changes, applies and undoes a plan", async () => {
    write(path.join(dl, "bill.txt"), "electric bill");
    write(path.join(dl, "notes.md"), "meeting notes");
    addPlace({ name: "Bills", path: path.join(root, "bills"), rule: "bills" });
    addPlace({ name: "Work", path: path.join(root, "work"), rule: "work" });
    const proposed = await propose(
      [
        { file: "bill.txt", place: "Bills" },
        { file: "notes.md", place: "Bills" },
      ],
      { source: dl },
    );

    const status = await api.status();
    expect(status.openPlans.map((p) => p.id)).toEqual([proposed.id]);

    const notes = path.join(dl, "notes.md");
    const plan = await api.plans.retarget({ planId: proposed.id, files: [notes], target: { place: "Work", name: "2025 meeting" } });
    expect(plan.items.find((i) => i.file === notes)).toMatchObject({ place: "Work", newName: "2025 meeting.md", status: "pending" });

    const preview = await api.plans.preview({ planId: proposed.id });
    expect(preview.wouldMove.map((m) => path.basename(m.to)).sort()).toEqual(["2025 meeting.md", "bill.txt"]);

    const { result, plan: applied } = await api.plans.apply({ planId: proposed.id, onConflict: "fail" });
    expect(result.failed).toEqual([]);
    expect(applied.state).toBe("done");
    expect(fs.existsSync(path.join(root, "work", "2025 meeting.md"))).toBe(true);

    expect(await api.history.list({ planId: proposed.id })).toHaveLength(2);
    const undone = await api.history.undo({ planId: proposed.id });
    expect(undone.undone).toHaveLength(2);
    expect(fs.existsSync(notes)).toBe(true);
    expect((await api.status()).undoableMoves).toBe(0);
  });

  it("edits places, rules and settings", async () => {
    await api.places.add({ name: "Bills", path: path.join(root, "bills"), rule: "" });
    await api.places.update({ name: "Bills", patch: { rule: "utility bills" } });
    expect((await api.places.list()).places).toEqual([{ name: "Bills", path: path.join(root, "bills"), rule: "utility bills" }]);

    await api.rules.add({ text: "never move drafts", scope: "global" });
    expect((await api.rules.list()).byScope).toEqual([{ scope: "global", rules: ["never move drafts"] }]);
    await expect(api.rules.add({ text: "x", scope: "project" })).rejects.toThrow(/No project here/);

    expect((await api.config.set({ key: "maskPersonal", value: "ssn,card", scope: "global" })).maskPersonal).toEqual(["ssn", "card"]);
    expect((await api.config.unset({ key: "maskPersonal", scope: "global" })).maskPersonal).toEqual([]);
    await expect(api.config.set({ key: "maxFiles", value: "lots", scope: "global" })).rejects.toThrow(/expected number/i);

    await api.sensitive.addCustomRule({ rule: { name: "acme", prefix: "acme_" }, scope: "global" });
    const { rules } = await api.sensitive.get();
    expect(rules.find((r) => r.id === "custom.acme")).toMatchObject({ custom: { prefix: "acme_" } });
  });
});
