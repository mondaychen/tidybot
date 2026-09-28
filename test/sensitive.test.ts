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

  it("flags by content", () => {
    expect(sensitiveByContent('{"installed":{"client_id":"x","client_secret":"GOCSPX-abc"}}')).toBeTruthy();
    expect(sensitiveByContent("token: ghp_" + "a".repeat(36))).toBeTruthy();
    expect(sensitiveByContent("-----BEGIN OPENSSH PRIVATE KEY-----\nabc")).toBeTruthy();
    expect(sensitiveByContent(["1. ab12-cd34", "2. ef56-gh78", "3. ij90-kl12", "4. mn34-op56", "5. qr78-st90"].join("\n"))?.rule).toBe("content.code-list");
    expect(sensitiveByContent("Meeting notes: discuss Q3 roadmap and hiring")).toBeUndefined();
    // a description of a secret is fine in a summary, the secret itself is not
    expect(sensitiveByContent("GitHub recovery codes file", { valuesOnly: true })).toBeUndefined();
  });
});
