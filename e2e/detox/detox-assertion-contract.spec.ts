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
    const detoxPageSource = await fs.readFile(
      path.join(repoDir, "e2e/detox/detox-page.js"),
      "utf8",
    );
    const assertTextBody = detoxRuntimeSource.slice(
      detoxRuntimeSource.indexOf("async assertText(stage"),
      detoxRuntimeSource.indexOf("async control(stage"),
    );

    // Then: Detox reads the id-owned target directly. This preserves Maestro's
    // copied-text contains assertion without adding a flaky text matcher.
    expect(assertTextBody).toContain("const target = await findVisibleTestID");
    expect(assertTextBody).not.toContain("waitForVisibleTestIDText");
    expect(assertTextBody).toContain("await target.getAttributes()");
    expect(assertTextBody).toContain("textFromAttributes");
    expect(assertTextBody).toContain(".includes(expectedText)");
    expect(detoxPageSource).not.toContain("waitForVisibleTestIDText");
    expect(detoxPageSource).not.toContain("by.text(");
  });

  it("opens a target-specific screen before waiting for assertion text", async () => {
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
    const findVisibleBody = detoxPageSource.slice(
      detoxPageSource.indexOf("async function findVisibleTestID"),
      detoxPageSource.indexOf(
        "async function withSynchronizationDisabledForAssertion",
      ),
    );

    expect(assertTextBody).toContain("const target = await findVisibleTestID");
    expect(assertTextBody).not.toContain("waitForVisibleTestIDText");
    expect(assertTextBody).not.toContain("expectedText,");
    expect(findVisibleBody).toContain("await openScreenForTestID(testID)");
    expect(findVisibleBody).toContain("const target = element(by.id(testID))");
    expect(findVisibleBody).toContain("await waitFor(target)");
    expect(findVisibleBody).toContain(".withTimeout(30000)");
    expect(findVisibleBody).not.toContain(".whileElement(");
    expect(findVisibleBody).not.toContain(".scroll(");
    expect(findVisibleBody).not.toContain("expectedText");
    expect(detoxPageSource).not.toContain("by.text(");
    expect(detoxPageSource).not.toContain("escapeRegExp(expectedText)");
  });

  it("opens deep-linked target screens without waiting for Detox app idle", async () => {
    const detoxPageSource = await fs.readFile(
      path.join(repoDir, "e2e/detox/detox-page.js"),
      "utf8",
    );
    const openScreenBody = detoxPageSource.slice(
      detoxPageSource.indexOf("async function openScreenForTestID"),
      detoxPageSource.indexOf(
        "async function ensureAppForegroundForInteraction",
      ),
    );

    expect(openScreenBody).toContain("withSynchronizationDisabledForPageOpen");
    expect(openScreenBody).toContain("openDeepLinkScreen");
    expect(openScreenBody).toContain(
      "openDeepLinkScreen(E2E_SCREEN_URLS[screenPath])",
    );
    expect(openScreenBody).toContain(
      "await waitForActiveScreen(E2E_SCREEN_CONTENT_TEST_IDS[screenPath])",
    );
    expect(openScreenBody).toContain('by.id("e2e-screen-content")');
    expect(openScreenBody).not.toContain("activateScreenPath");
    expect(detoxPageSource).toContain("async function openDeepLinkScreen");
    expect(detoxPageSource).toContain("launchApp({ newInstance: false, url })");
    expect(detoxPageSource).not.toContain("device.openURL({");
    expect(openScreenBody.indexOf("openDeepLinkScreen")).toBeLessThan(
      openScreenBody.indexOf('by.id("e2e-screen-content")'),
    );
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
