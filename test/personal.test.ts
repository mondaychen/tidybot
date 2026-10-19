import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { PERSONAL_KINDS, maskPersonal, maskSummary, parsePersonalKinds } from "../src/personal.js";
import { scan } from "../src/scan.js";
import { loadConfig, setConfigValue } from "../src/store/config.js";
import { findSummaries } from "../src/store/summaries.js";
import { getSummaries, saveSummaries } from "../src/summarize.js";
import { sandbox, write } from "./helpers.js";

const ALL = PERSONAL_KINDS;

describe("maskPersonal", () => {
  it("masks each kind of personal data", () => {
    const cases: [string, string][] = [
      ["SSN: 536-22-1234.", "SSN: [SSN]."],
      ["Social Security Number is 536221234", "Social Security Number is [SSN]"],
      ["Passport No.: 123456789", "Passport No.: [PASSPORT]"],
      ["护照号码：E12345678", "护照号码：[PASSPORT]"],
      ["身份证 11010519491231002X 有效", "身份证 [ID CARD] 有效"],
      ["Visa 4111 1111 1111 1111 exp 12/27", "Visa [CARD …1111] exp 12/27"],
      ["Amex 3782 822463 10005", "Amex [CARD …0005]"],
      ["IBAN DE89 3704 0044 0532 0130 00 BIC COBADEFFXXX", "IBAN [IBAN …3000] BIC COBADEFFXXX"],
      ["to GB82WEST12345698765432.", "to [IBAN …5432]."],
      ["Date of birth: 1990-03-05", "Date of birth: [DATE OF BIRTH]"],
      ["born on March 5, 1990 in Ohio", "born on [DATE OF BIRTH] in Ohio"],
      ["出生日期：1990年3月5日", "出生日期：[DATE OF BIRTH]"],
      ["From: john.smith@chase.com", "From: [EMAIL]@chase.com"],
    ];
    for (const [text, masked] of cases) expect(maskPersonal(text, ALL), text).toBe(masked);
  });

  it("leaves what only looks like personal data", () => {
    for (const text of [
      "Statement date: May 01, 2023, due 2023-05-28",
      "Order #4111111111111112", // fails the Luhn check
      "Example SSN 123-45-6789", // the one printed in examples
      "SSN 000-12-3456",
      "Passport: required",
      "Ref GB82WEST12345698765433", // wrong IBAN check digits
      "Version 1.2.3 of 2024-01-02",
      "ID 110105194912310021", // wrong check digit
    ]) {
      expect(maskPersonal(text, ALL), text).toBe(text);
    }
  });

  it("masks only the kinds asked for, and masked text masks to itself", () => {
    const text = "SSN 536-22-1234, card 4111111111111111, mail ann@example.org";
    expect(maskPersonal(text, ["card"])).toBe("SSN 536-22-1234, card [CARD …1111], mail ann@example.org");
    expect(maskPersonal(text, [])).toBe(text);
    const masked = maskPersonal(text, ALL);
    expect(masked).toBe("SSN [SSN], card [CARD …1111], mail [EMAIL]@example.org");
    expect(maskPersonal(masked, ALL)).toBe(masked);
  });

  it("masks keywords, which are lowercase, and the summary's values in them", () => {
    expect(maskSummary("Passport scan, Passport No: X1234567", ["de89370400440532013000", "x1234567", "travel"], ALL)).toEqual({
      summary: "Passport scan, Passport No: [PASSPORT]",
      keywords: ["[iban …3000]", "[passport]", "travel"],
    });
  });

  it("parses config values", () => {
    expect(parsePersonalKinds("all")).toEqual([...PERSONAL_KINDS]);
    expect(parsePersonalKinds("none")).toEqual([]);
    expect(parsePersonalKinds("")).toEqual([]);
    expect(parsePersonalKinds("ssn, Card ssn")).toEqual(["ssn", "card"]);
  });
});

describe("personal data in excerpts and summaries", () => {
  let dl: string;

  beforeEach(() => {
    dl = path.join(sandbox(), "dl");
    fs.mkdirSync(dl);
  });

  it("is off until turned on, and rejects unknown kinds", () => {
    expect(loadConfig().maskPersonal).toEqual([]);
    expect(setConfigValue("maskPersonal", "ssn,iban").maskPersonal).toEqual(["ssn", "iban"]);
    expect(() => setConfigValue("maskPersonal", "ssn,phone")).toThrow();
  });

  it("masks scan excerpts and the cached text of short files", async () => {
    const file = write(path.join(dl, "statement.txt"), "Chase statement for card 4111 1111 1111 1111, SSN 536-22-1234");
    setConfigValue("maskPersonal", "all");
    const { files } = await scan(dl, { maxFiles: 10, excerptChars: 1000 });
    expect(files[0]?.excerpt).toBe("Chase statement for card [CARD …1111], SSN [SSN]");
    expect(JSON.stringify(await getSummaries([file], dl))).not.toContain("536-22-1234");
    expect(fs.readFileSync(path.join(process.env.TIDYBOT_HOME as string, "summaries.jsonl"), "utf8")).not.toContain("536-22-1234");
  });

  it("masks before the excerpt is cut, so no part of a number shows", async () => {
    write(path.join(dl, "long.txt"), `Card ${"4111 1111 1111 1111"} ${"filler ".repeat(50)}`);
    setConfigValue("maskPersonal", "card");
    const { files } = await scan(dl, { maxFiles: 10, excerptChars: 14 });
    expect(files[0]?.excerpt).toBe("Card [CARD …11");
  });

  it("masks agent summaries when saved, and older ones when read", async () => {
    const a = write(path.join(dl, "a.pdf"), "%PDF-a");
    const b = write(path.join(dl, "b.pdf"), "%PDF-b");
    await saveSummaries([{ file: a, summary: "Passport scan, Passport No: X1234567", keywords: ["passport", "X1234567"] }], { base: dl });
    setConfigValue("maskPersonal", "passport,iban");
    expect(JSON.stringify(await getSummaries([a], dl))).not.toContain("1234567");

    await saveSummaries([{ file: b, summary: "Wire to DE89 3704 0044 0532 0130 00", keywords: ["DE89370400440532013000"] }], { base: dl });
    const [saved] = await getSummaries([b], dl);
    expect(saved?.summary).toMatchObject({ summary: "Wire to [IBAN …3000]", keywords: ["[iban …3000]"] });
    expect(await findSummaries("X1234567", { limit: 10 })).toEqual([]);
  });
});
