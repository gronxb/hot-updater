import fs from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

const repoDir = path.resolve(import.meta.dirname, "../..");
const detoxScenarioRuntimePath = path.join(
  repoDir,
  "e2e/detox/detox-app-driver.js",
);

describe("Detox assertion parity", () => {
  it("accepts both stable transition states after OTA activation", async () => {
    // Given: a stable launch may report the transition once or a later unchanged launch.
    const detoxRuntimeSource = await fs.readFile(
      detoxScenarioRuntimePath,
      "utf8",
    );
    const stableLaunchBody = detoxRuntimeSource.slice(
      detoxRuntimeSource.indexOf("async assertStableLaunch(stage"),
      detoxRuntimeSource.indexOf("async assertText(stage"),
    );

    // Then: the assertion keeps both explicit native states and rejects recovery.
    expect(stableLaunchBody).toContain(
      '"Current Launch Status: UPDATE_APPLIED"',
    );
    expect(stableLaunchBody).toContain('"Current Launch Status: UNCHANGED"');
    expect(stableLaunchBody).not.toContain(
      '"Current Launch Status: RECOVERED"',
    );
  });

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

    // Then: Detox reads the id-owned target directly, while exact result
    // assertions can wait on the same target without adding start-count UI.
    expect(assertTextBody).toContain("const target = await findVisibleTestID");
    expect(assertTextBody).toContain("if (options.exactText === true)");
    expect(assertTextBody).toContain("waitForCurrentTestIDText");
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
    expect(assertTextBody).toContain("waitForCurrentTestIDText");
    expect(assertTextBody).toContain(
      "await waitForCurrentTestIDText(testID, expectedText)",
    );
    expect(findVisibleBody).toContain("await openScreenForTestID(testID, {");
    expect(findVisibleBody).toContain("alwaysOpen: options.alwaysOpen");
    expect(findVisibleBody).toContain("const target = element(by.id(testID))");
    expect(findVisibleBody).toContain("await waitFor(target)");
    expect(findVisibleBody).toContain(".withTimeout(30000)");
    expect(findVisibleBody).not.toContain(".whileElement(");
    expect(findVisibleBody).not.toContain(".scroll(");
    expect(findVisibleBody).not.toContain("expectedText");
    expect(detoxPageSource).not.toContain("by.text(");
    expect(detoxPageSource).not.toContain("escapeRegExp(expectedText)");
  });

  it("waits for exact action-result screen state before matching UI text", async () => {
    const detoxRuntimeSource = await fs.readFile(
      detoxScenarioRuntimePath,
      "utf8",
    );
    const assertTextBody = detoxRuntimeSource.slice(
      detoxRuntimeSource.indexOf("async assertText(stage"),
      detoxRuntimeSource.indexOf("async control(stage"),
    );

    expect(detoxRuntimeSource).toContain("ACTION_RESULT_TEXT_FIELDS");
    expect(detoxRuntimeSource).toContain(
      '"update-action-result": "updateActionResult"',
    );
    expect(assertTextBody).toContain(
      "waitForExpectedActionResultText(\n            stage,\n            testID,\n            expectedText,\n          )",
    );
    expect(detoxRuntimeSource).toContain("expectedValue: expectedText");
    expect(detoxRuntimeSource).not.toMatch(/\bretry\b/i);
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
    const openDeepLinkScreenBody = detoxPageSource.slice(
      detoxPageSource.indexOf("async function openDeepLinkScreen"),
      detoxPageSource.indexOf(
        "async function ensureAppForegroundForInteraction",
      ),
    );

    expect(openScreenBody).toContain("withSynchronizationDisabledForPageOpen");
    expect(openScreenBody).toContain("openDeepLinkScreen");
    expect(openScreenBody).toContain(
      "openDeepLinkScreen(E2E_SCREEN_URLS[screenPath])",
    );
    expect(openScreenBody).not.toContain("waitForActiveScreen");
    expect(detoxPageSource).not.toContain("E2E_SCREEN_CONTENT_TEST_IDS");
    expect(openScreenBody).not.toContain('by.id("e2e-screen-content")');
    expect(openScreenBody).not.toContain("activateScreenPath");
    expect(detoxPageSource).toContain("async function openDeepLinkScreen");
    expect(detoxPageSource).toContain("if (isAndroidRun())");
    expect(detoxPageSource).toContain(
      "await launchApp({ newInstance: false, url });",
    );
    expect(detoxPageSource).toContain(
      "await launchApp({ newInstance: false });",
    );
    expect(
      openDeepLinkScreenBody.indexOf(
        "await launchApp({ newInstance: false });",
      ),
    ).toBeLessThan(
      openDeepLinkScreenBody.indexOf(
        "await disableSynchronizationUntilLaunch();",
      ),
    );
    expect(
      openDeepLinkScreenBody.indexOf(
        "await disableSynchronizationUntilLaunch();",
      ),
    ).toBeLessThan(
      openDeepLinkScreenBody.indexOf("await device.openURL({ url });"),
    );
    expect(detoxPageSource).toContain("await device.openURL({ url });");
    const openUrlIndex = openDeepLinkScreenBody.indexOf(
      "await device.openURL({ url });",
    );
    const postOpenUrlFlagResetIndex = openDeepLinkScreenBody.indexOf(
      "synchronizationDisabledUntilLaunch = false;",
      openUrlIndex,
    );
    const postOpenUrlDisableIndex = openDeepLinkScreenBody.indexOf(
      "await disableSynchronizationUntilLaunch();",
      openUrlIndex + 1,
    );
    expect(postOpenUrlFlagResetIndex).toBeGreaterThan(openUrlIndex);
    expect(postOpenUrlDisableIndex).toBeGreaterThan(postOpenUrlFlagResetIndex);
    expect(
      detoxPageSource.indexOf("await launchApp({ newInstance: false });"),
    ).toBeLessThan(detoxPageSource.indexOf("await device.openURL({ url });"));
    expect(openScreenBody).not.toContain("e2e-screen-content");
  });

  it("reads assertion text with Detox synchronization disabled until launch", async () => {
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
    expect(assertionSyncBody).toContain("disableSynchronizationUntilLaunch()");
    expect(detoxPageSource).toContain("device.disableSynchronization()");
    expect(assertionSyncBody).not.toContain("shouldRestoreSynchronization");
    expect(assertionSyncBody).not.toContain("finally");
    expect(assertionSyncBody).not.toContain("device.enableSynchronization()");
    expect(assertionSyncBody).not.toMatch(/\bretry\b/i);
    expect(assertionSyncBody).not.toMatch(/\bsetTimeout\b/i);
  });
});
