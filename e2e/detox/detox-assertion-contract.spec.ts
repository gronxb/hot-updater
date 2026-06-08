import fs from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

const repoDir = path.resolve(import.meta.dirname, "../..");
const detoxScenarioRuntimePath = path.join(
  repoDir,
  "e2e/detox/detox-app-driver.js",
);

describe("Detox assertion parity", () => {
  it("reads expected text from the visible testID like Maestro copyTextFrom assertions", async () => {
    // Given: Maestro asserted a visible testID, copied that node's text, then
    // checked that the copied text included the expected value.
    const detoxRuntimeSource = await fs.readFile(
      detoxScenarioRuntimePath,
      "utf8",
    );
    const assertTextBody = detoxRuntimeSource.slice(
      detoxRuntimeSource.indexOf("async assertText(stage"),
      detoxRuntimeSource.indexOf("async control(stage"),
    );

    // Then: Detox must wait for the expected text to be present before reading
    // the id-owned target. This preserves Maestro's bounded visible text
    // assertion while still reading the final value from the target testID.
    expect(assertTextBody).toContain("const target = await findVisibleTestID");
    expect(assertTextBody).toContain("expectedText,");
    expect(assertTextBody).toContain("await target.getAttributes()");
    expect(assertTextBody).toContain("textFromAttributes");
    expect(assertTextBody).toContain(".includes(expectedText)");
    expect(assertTextBody).toContain(".toBeVisible()");
    expect(assertTextBody).toContain(".withTimeout(30000)");
  });

  it("reads assertion text with Detox synchronization temporarily disabled", async () => {
    // Given: provider runs can leave the app busy after channel/cohort actions
    // even when the user-visible text is ready to inspect.
    const detoxRuntimeSource = await fs.readFile(
      detoxScenarioRuntimePath,
      "utf8",
    );
    const detoxPageSource = await fs.readFile(
      path.join(repoDir, "e2e/detox/detox-page.js"),
      "utf8",
    );
    const assertTextBody = detoxRuntimeSource.slice(
      detoxRuntimeSource.indexOf("async assertText(stage"),
      detoxRuntimeSource.indexOf("async control(stage"),
    );
    const assertionSyncBody = detoxPageSource.slice(
      detoxPageSource.indexOf(
        "async function withSynchronizationDisabledForAssertion",
      ),
      detoxPageSource.indexOf("module.exports"),
    );

    // Then: assertions do not fail solely because Detox waits for a busy queue.
    expect(assertTextBody).toContain("withSynchronizationDisabledForAssertion");
    expect(assertionSyncBody).toContain(
      "const shouldRestoreSynchronization = !synchronizationDisabledUntilLaunch",
    );
    expect(assertionSyncBody).toContain("device.disableSynchronization()");
    expect(assertionSyncBody).toContain("finally");
    expect(assertionSyncBody).toContain("device.enableSynchronization()");
    expect(assertionSyncBody).not.toMatch(/\bretry\b/i);
    expect(assertionSyncBody).not.toMatch(/\bsetTimeout\b/i);
  });
});
