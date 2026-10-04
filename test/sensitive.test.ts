import { describe, expect, it } from "vitest";
import { sensitiveByContent, sensitiveByName } from "../src/sensitive.js";

describe("sensitive file detection", () => {
  it("flags by name", () => {
    for (const n of ["github-recovery-codes.txt", "Carta backup codes.txt", "1Password Emergency Kit.pdf", "client_secret_123.json", "server.pem", "prod.env", "id_ed25519"]) {
      expect(sensitiveByName(n), n).toBeTruthy();
    }
    for (const n of ["invoice.pdf", "roadmap.md", "environment-report.pdf", "economics-talk.pdf"]) {
      expect(sensitiveByName(n), n).toBeUndefined();
    }
  });

  it("flags by content", async () => {
    expect(await sensitiveByContent('{"installed":{"client_id":"x","client_secret":"GOCSPX-abc"}}')).toBeTruthy();
    expect(await sensitiveByContent("token: ghp_" + "a".repeat(36))).toBeTruthy();
    expect(await sensitiveByContent("-----BEGIN OPENSSH PRIVATE KEY-----\nabc")).toBeTruthy();
    expect((await sensitiveByContent(["1. ab12-cd34", "2. ef56-gh78", "3. ij90-kl12", "4. mn34-op56", "5. qr78-st90"].join("\n")))?.rule).toBe("content.code-list");
    expect(await sensitiveByContent("Meeting notes: discuss Q3 roadmap and hiring")).toBeUndefined();
    // a description of a secret is fine in a summary, the secret itself is not
    expect(await sensitiveByContent("GitHub recovery codes file", { valuesOnly: true })).toBeUndefined();
  });

  it("flags secrets that secretlint's recommended rules know", async () => {
    const npm = "npm_" + "a1B2".repeat(9);
    const hit = await sensitiveByContent(`publish from CI with ${npm}`, { valuesOnly: true });
    expect(hit).toEqual({ rule: "content.secretlint", reason: "secret value (npm)" });
    expect((await sensitiveByContent("DATABASE_URL=postgres://app:hunter22@db.example.com/prod"))?.rule).toBe("content.secretlint");
    // A comment in the file can't switch detection off.
    expect(await sensitiveByContent(`// secretlint-disable\n${npm}`)).toBeTruthy();
    expect(await sensitiveByContent(npm, { disabled: new Set(["content.secretlint"]) })).toBeUndefined();
  });
});
