import fs from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

const repoDir = path.resolve(import.meta.dirname, "../..");
const detoxScenarioRuntimePath = path.join(
  repoDir,
  "e2e/detox/detox-app-driver.js",
);

describe("Detox assertion parity", () => {
  it("waits for expected text on the same testID like Maestro text assertions", async () => {
    // Given: Maestro asserted a visible testID and expected text together.
    const detoxRuntimeSource = await fs.readFile(
      detoxScenarioRuntimePath,
      "utf8",
    );
    const assertTextBody = detoxRuntimeSource.slice(
      detoxRuntimeSource.indexOf("async assertText(stage"),
      detoxRuntimeSource.indexOf("async control(stage"),
    );

    // Then: Detox must wait for that combined id/text match before reading text.
    expect(assertTextBody).toContain("escapeRegExp");
    expect(assertTextBody).toContain("by.id(testID).and(");
    expect(assertTextBody).toContain("by.text(new RegExp");
    expect(assertTextBody).toContain("await waitFor(matchedTarget)");
    expect(assertTextBody).toContain(".toBeVisible()");
    expect(assertTextBody).toContain(".withTimeout(30000)");
  });
});
