import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { sandbox } from "./helpers.js";

describe("sandbox", () => {
  const before = { home: process.env.TIDYBOT_HOME, noProject: process.env.TIDYBOT_NO_PROJECT };
  let root = "";

  it("points tidybot at a fresh directory", () => {
    root = sandbox();
    expect(process.env.TIDYBOT_HOME).toBe(path.join(root, "home"));
    expect(process.env.TIDYBOT_NO_PROJECT).toBe("1");
  });

  // Runs after the test above: test files need no cleanup code of their own.
  it("is undone after each test", () => {
    expect(process.env.TIDYBOT_HOME).toBe(before.home);
    expect(process.env.TIDYBOT_NO_PROJECT).toBe(before.noProject);
    expect(fs.existsSync(root)).toBe(false);
  });
});
