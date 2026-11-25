import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { identity } from "../src/file-move.js";
import { writeJson } from "../src/store/io.js";
import { propose } from "../src/planner.js";
import { addPlace } from "../src/store/places.js";
import { ORPCError, createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { ContractRouterClient } from "@orpc/contract";
import type { contract } from "../src/ui/contract.js";
import { DEFAULT_PORT, type UiServer, startUiServer } from "../src/ui/server.js";
import { onPlatform, sandbox, write } from "./helpers.js";

/** Stands in for the system Trash, so tests never touch the real one. */
const systemTrash = vi.hoisted(() => ({ dir: "" }));
vi.mock("trash", () => ({
  default: vi.fn(async (paths: string[]) => {
    for (const p of paths) fs.renameSync(p, path.join(systemTrash.dir, path.basename(p)));
  }),
}));

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
function request(opts: {
  method?: string;
  path: string;
  headers?: Record<string, string>;
  body?: string;
  port?: number;
}): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: opts.port ?? server.port, method: opts.method ?? "POST", path: opts.path, headers: opts.headers }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c: string) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
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
    // As many characters as the token, but more bytes.
    const odd = `Bearer ${TOKEN.slice(0, -1)}\u00e9`;
    expect((await request({ path: "/api/status", headers: { ...headers, authorization: odd }, body: b })).status).toBe(401);
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
    // Paths the file system refuses get an answer, and the server keeps running.
    expect((await request({ method: "GET", path: "/%00" })).status).toBe(400);
    expect((await request({ method: "GET", path: `/${"a".repeat(5000)}` })).status).toBe(400);
    expect((await request({ method: "GET", path: "/" })).status).toBe(200);
  });

  it("caches the built assets only, and keeps running when the page is gone", async () => {
    // A folder named "assets" above the frontend doesn't make the page an asset.
    const web = write(path.join(root, "assets/web/index.html"), "<!doctype html>");
    write(path.join(root, "assets/web/assets/app.js"), "1");
    const other = await startUiServer({ port: 0, token: TOKEN, staticDir: path.dirname(web) });
    onTestFinished(() => other.close());
    const get = (p: string) => request({ method: "GET", path: p, port: other.port });
    expect((await get("/")).headers["cache-control"]).toBe("no-cache");
    expect((await get("/assets/app.js")).headers["cache-control"]).toContain("immutable");

    // A build empties the folder while the server runs.
    fs.rmSync(web);
    expect((await get("/plans/p1")).status).toBe(503);
    expect((await get("/assets/app.js")).status).toBe(200);
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
    write(path.join(dl, "keep.txt"), "keep me");
    addPlace({ name: "Bills", path: path.join(root, "bills"), rule: "bills" });
    addPlace({ name: "Work", path: path.join(root, "work"), rule: "work" });
    const proposed = await propose(
      [
        { file: "bill.txt", place: "Bills" },
        { file: "notes.md", place: "Bills" },
        { file: "keep.txt", skip: true },
      ],
      { source: dl },
    );
    const none = { toMove: 0, toDelete: 0, attention: 0, left: 0, moved: 0, deleted: 0, putBack: 0, inSystemTrash: 0, canUndo: 0, canUndoDeleted: 0 };

    const status = await api.status();
    expect(status.openPlans.map((p) => p.id)).toEqual([proposed.id]);
    expect(status.openPlans[0]).toMatchObject({ appliedAt: null, counts: { ...none, total: 3, toMove: 2, left: 1 } });

    const notes = path.join(dl, "notes.md");
    const plan = await api.plans.retarget({ planId: proposed.id, files: [notes], target: { place: "Work", name: "2025 meeting" } });
    expect(plan.items.find((i) => i.file === notes)).toMatchObject({ place: "Work", newName: "2025 meeting.md", status: "pending" });

    const preview = await api.plans.preview({ planId: proposed.id });
    expect(preview.wouldMove.map((m) => path.basename(m.to)).sort()).toEqual(["2025 meeting.md", "bill.txt"]);

    const { result, plan: applied } = await api.plans.apply({ planId: proposed.id, onConflict: "fail" });
    expect(result.failed).toEqual([]);
    expect(applied.state).toBe("done");
    expect(applied.appliedAt).not.toBeNull();
    expect(applied.counts).toEqual({ ...none, total: 3, moved: 2, left: 1, canUndo: 2 });
    expect(fs.existsSync(path.join(root, "work", "2025 meeting.md"))).toBe(true);

    // Undo changes the history, not the plan file: the plan's counts and items still follow it.
    const bill = applied.items.find((i) => i.file === path.join(dl, "bill.txt"));
    expect(bill?.undo).toBe("available");
    await api.history.undo({ ids: [bill?.operationId ?? ""] });
    const partly = await api.plans.get({ id: proposed.id });
    expect(partly.counts).toEqual({ ...none, total: 3, moved: 1, left: 1, putBack: 1, canUndo: 1 });
    expect(partly.items.find((i) => i.file === bill?.file)?.undo).toBe("putBack");
    expect((await api.plans.list({ all: true }))[0]?.counts).toEqual(partly.counts);

    const undone = await api.history.undo({ planId: proposed.id });
    expect(undone.undone).toHaveLength(1);
    expect(fs.existsSync(notes)).toBe(true);
    expect((await api.status()).undoableMoves).toBe(0);
  });

  it("reopens an undone plan as a new plan, and links the two", async () => {
    write(path.join(dl, "bill.txt"), "electric bill");
    write(path.join(dl, "notes.md"), "meeting notes");
    addPlace({ name: "Bills", path: path.join(root, "bills"), rule: "bills" });
    const proposed = await propose(
      [
        { file: "bill.txt", place: "Bills" },
        { file: "notes.md", place: "Bills" },
      ],
      { source: dl },
    );
    const { plan: applied } = await api.plans.apply({ planId: proposed.id, onConflict: "fail" });
    await api.history.undo({ ids: [applied.items[0]?.operationId ?? ""] });

    const { plan, left } = await api.plans.reopen({ planId: proposed.id });
    expect(plan).toMatchObject({ state: "open", reopenedFrom: proposed.id, counts: { total: 1, toMove: 1 } });
    expect(left).toEqual([{ file: path.join(dl, "notes.md"), reason: "stillMoved", at: path.join(root, "bills", "notes.md"), undoId: applied.items[1]?.operationId }]);

    expect((await api.plans.get({ id: proposed.id })).reopenedAs).toBe(plan.id);
    const listed = await api.plans.list({ all: true });
    expect(listed.find((p) => p.id === proposed.id)?.reopenedAs).toBe(plan.id);
    expect(listed.find((p) => p.id === plan.id)?.reopenedFrom).toBe(proposed.id);
    expect(await codeOf(api.plans.reopen({ planId: proposed.id }))).toBe("already_reopened");

    // Discarded, the new plan no longer counts as the old plan's copy.
    await api.plans.discard({ planId: plan.id });
    expect((await api.plans.get({ id: proposed.id })).reopenedAs).toBeUndefined();
  });

  it("puts back a plan's moved files, and leaves out the files in the system Trash", async () => {
    onPlatform("darwin");
    systemTrash.dir = path.join(root, "system-trash");
    fs.mkdirSync(systemTrash.dir);
    write(path.join(dl, "bill.txt"), "electric bill");
    write(path.join(dl, "bill copy.txt"), "electric bill");
    addPlace({ name: "Bills", path: path.join(root, "bills"), rule: "bills" });
    const plan = await propose(
      [
        { file: "bill.txt", place: "Bills" },
        { file: "bill copy.txt", delete: true },
      ],
      { source: dl },
    );
    const { plan: applied } = await api.plans.apply({ planId: plan.id, onConflict: "fail" });
    expect(applied.counts).toMatchObject({ moved: 1, deleted: 1, inSystemTrash: 1, canUndo: 1 });

    expect(await api.history.undo({ planId: plan.id })).toMatchObject({ undone: [{ to: path.join(dl, "bill.txt") }], failed: [] });
    // Asked for by id, the file in the Trash still says why it can't come back.
    const gone = applied.items.find((i) => i.undo === "systemTrash");
    const byId = await api.history.undo({ ids: [gone?.operationId ?? ""] });
    expect(byId.failed[0]?.error).toMatch(/system Trash/);
  });

  it("doesn't report another process's running move as interrupted", async () => {
    const from = write(path.join(dl, "big.bin"), "data");
    const to = path.join(root, "out", "big.bin");
    const op = { entry: { kind: "move", id: "m1", at: new Date().toISOString(), from, to }, from, to, source: identity(from) };
    const journal = path.join(root, "home", "operations", "m1.json");
    writeJson(journal, op);
    // The claim of a live process that is not this one.
    const claim = write(path.join(root, "home", "move-locks", `${process.ppid}-${randomUUID()}.lock`));
    expect((await api.status()).interrupted).toEqual([]);
    expect(fs.existsSync(journal)).toBe(true);
  });

  it("refuses to apply a plan that changed after the preview", async () => {
    write(path.join(dl, "bill.txt"), "electric bill");
    write(path.join(dl, "notes.md"), "meeting notes");
    addPlace({ name: "Bills", path: path.join(root, "bills"), rule: "bills" });
    const plan = await propose([{ file: "bill.txt", place: "Bills" }, { file: "notes.md", place: "Bills" }], { source: dl });
    const { revision } = await api.plans.preview({ planId: plan.id });
    expect((await api.plans.preview({ planId: plan.id })).revision).toBe(revision);

    // As the agent does through the CLI, while the confirm sheet is open.
    await api.plans.retarget({ planId: plan.id, files: [path.join(dl, "notes.md")], target: { delete: true } });
    expect(await codeOf(api.plans.apply({ planId: plan.id, onConflict: "fail", revision }))).toBe("plan_changed");
    expect(fs.existsSync(path.join(dl, "bill.txt"))).toBe(true);

    await api.plans.skip({ planId: plan.id, files: [path.join(dl, "notes.md")] });
    const again = await api.plans.preview({ planId: plan.id });
    const { result } = await api.plans.apply({ planId: plan.id, onConflict: "fail", revision: again.revision });
    expect(result.moved).toHaveLength(1);
  });

  it("refuses to apply when the trash setting changed after the preview", async () => {
    onPlatform("darwin");
    write(path.join(dl, "bill copy.txt"), "electric bill");
    const plan = await propose([{ file: "bill copy.txt", delete: true }], { source: dl });
    await api.config.set({ key: "trashDir", value: path.join(root, "bin"), scope: "global" });
    const { revision } = await api.plans.preview({ planId: plan.id });
    // Now a deleted file would go to the system Trash, where undo can't reach it.
    await api.config.unset({ key: "trashDir", scope: "global" });
    expect(await codeOf(api.plans.apply({ planId: plan.id, onConflict: "fail", revision }))).toBe("plan_changed");
    expect(fs.existsSync(path.join(dl, "bill copy.txt"))).toBe(true);
  });

  it("shows the name that a file got when its name was taken", async () => {
    const file = write(path.join(dl, "bill.txt"), "electric bill");
    write(path.join(root, "bills", "bill.txt"), "an older bill");
    addPlace({ name: "Bills", path: path.join(root, "bills"), rule: "bills" });
    const plan = await propose([{ file: "bill.txt", place: "Bills" }], { source: dl });
    const { result, plan: applied } = await api.plans.apply({ planId: plan.id, onConflict: "rename" });
    expect(result.moved.map((m) => path.basename(m.to))).toEqual(["bill (1).txt"]);
    expect(applied.items.find((i) => i.file === file)).toMatchObject({ status: "moved", newName: "bill (1).txt" });
  });

  it("says how many cut-off moves a recovery resolved", async () => {
    const from = write(path.join(dl, "big.bin"), "data");
    const to = path.join(root, "out", "big.bin");
    writeJson(path.join(root, "home", "operations", "m1.json"), { entry: { kind: "move", id: "m1", at: new Date().toISOString(), from, to }, from, to, source: identity(from) });
    expect(await api.recover.run()).toEqual({ resolved: 1, interrupted: [] });
    expect(await api.recover.run()).toEqual({ resolved: 0, interrupted: [] });
  });

  it("keeps the two scopes of a project apart", async () => {
    await api.config.set({ key: "maskPersonal", value: "ssn", scope: "global" });
    await api.sensitive.setRule({ id: "name.extension", allowed: true, scope: "global" });
    await api.sensitive.addCustomRule({ rule: { name: "acme", prefix: "acme_" }, scope: "global" });
    const proj = path.join(root, "proj");
    fs.mkdirSync(path.join(proj, ".tidybot"), { recursive: true });
    vi.stubEnv("TIDYBOT_NO_PROJECT", "");
    vi.stubEnv("TIDYBOT_PROJECT", proj);
    expect((await api.status()).project).toBe(proj);

    // A global change starts from `global`, not from the project's value.
    await api.config.set({ key: "maskPersonal", value: "email", scope: "project" });
    const { config, global } = await api.config.get();
    expect([config.maskPersonal, global.maskPersonal]).toEqual([["email"], ["ssn"]]);

    await api.sensitive.addCustomRule({ rule: { name: "beta", prefix: "beta_" }, scope: "project" });
    const { rules } = await api.sensitive.get();
    expect(rules.find((r) => r.id === "name.extension")).toMatchObject({ allowed: true, allowedIn: ["global"] });
    expect(rules.find((r) => r.id === "custom.acme")?.custom?.scope).toBe("global");
    expect(rules.find((r) => r.id === "custom.beta")?.custom?.scope).toBe("project");
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
    expect(await codeOf(api.config.set({ key: "excerptChars", value: "", scope: "global" }))).toBe("invalid_input");

    await api.sensitive.addCustomRule({ rule: { name: "acme", prefix: "acme_" }, scope: "global" });
    const { rules } = await api.sensitive.get();
    expect(rules.find((r) => r.id === "custom.acme")).toMatchObject({ custom: { prefix: "acme_" } });
  });
});
