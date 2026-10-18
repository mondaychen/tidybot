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

  it("flags secrets that secretlint's recommended rules miss", async () => {
    const r = (n: number) => "aB3dE6gH9jK2mN5pQ8sT1vW4yZ7cF0hJ3lP6rU9xA2dG5kM8".repeat(2).slice(0, n);
    const cases: [string, string][] = [
      ["-----BEGIN PGP PRIVATE KEY BLOCK-----\nlQOYBF", "content.private-key"],
      ["-----BEGIN ENCRYPTED PRIVATE KEY-----\nMIIF", "content.private-key"],
      ["export AWS_ACCESS_KEY_ID=ASIAABCDEFGHIJ234567", "content.aws-key"],
      [`HF_TOKEN hf_${r(34)}`, "content.huggingface-token"],
      [`xai-${r(80)}`, "content.xai-key"],
      [`pypi-${r(60)}`, "content.pypi-token"],
      [`dop_v1_${"0123456789abcdef".repeat(4)}`, "content.digitalocean-token"],
      [`relay key oc_sk_${r(30)}`, "content.relay-key"],
      ["broker amqp://guest:S3cretPw77@mq.local:5672/", "content.url-password"],
      ["redis://default:Zq8mN3pX7vK2@cache.internal:6379", "content.url-password"],
      [`{"key": "${r(32)}"}`, "content.key-field"],
    ];
    for (const [text, rule] of cases) {
      expect((await sensitiveByContent(text, { valuesOnly: true }))?.rule, text).toBe(rule);
    }
  });

  it("doesn't take a placeholder or a plain word for a credential", async () => {
    for (const text of [
      "password: ${DB_PASSWORD}",
      "password = ********",
      "api_key = <your-api-key-here>",
      "Password: __________",
      "secret: {{ vault_secret }}",
      "Reset your password: required.",
      "redis://default:${REDIS_PASSWORD}@cache:6379",
      '{"key": "customer-satisfaction-survey"}',
    ]) {
      expect(await sensitiveByContent(text), text).toBeUndefined();
    }
    // A placeholder first doesn't hide a real value later in the same text.
    expect((await sensitiveByContent("password: ${PW}\npassword: hunter2345"))?.rule).toBe("content.assignment");
    // A password of letters only still counts when it doesn't read as one plain word.
    for (const pw of ["CorrectHorseBattery", "correcthorsebatterystaple", "p@ssword"]) {
      expect((await sensitiveByContent(`password: ${pw}`))?.rule, pw).toBe("content.assignment");
    }
  });

  it("flags secrets that secretlint's recommended rules know", async () => {
    const npm = "npm_" + "a1B2".repeat(9);
    const hit = await sensitiveByContent(`publish from CI with ${npm}`, { valuesOnly: true });
    expect(hit).toEqual({ rule: "content.secretlint", reason: "secret value (npm)" });
    const sendgrid = `SG.${"a1B2c3D4e5".repeat(3).slice(0, 22)}.${"a1B2c3D4e5".repeat(5).slice(0, 43)}`;
    expect((await sensitiveByContent(`mail via ${sendgrid}`))?.reason).toBe("secret value (sendgrid)");
    // A comment in the file can't switch detection off.
    expect(await sensitiveByContent(`// secretlint-disable\n${npm}`)).toBeTruthy();
    expect(await sensitiveByContent(npm, { disabled: new Set(["content.secretlint"]) })).toBeUndefined();
  });
});
