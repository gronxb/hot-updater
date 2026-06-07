const { by, device, element, expect: detoxExpect, waitFor } = require("detox");
const {
  disableSynchronizationUntilLaunch,
  findVisibleTestID,
  isAndroidRun,
  launchApp,
  shouldDisableSynchronizationForTap,
  textFromAttributes,
} = require("./detox-page.js");

class DetoxAppDriver {
  constructor(client) {
    this.controlClient = client;
    this.stageValues = {};
  }

  async assertText(stage, testID, contains, options = {}) {
    await this.runStage(stage, async () => {
      const target = await findVisibleTestID(this.controlClient, testID, {
        ensureForeground: options.ensureForeground,
      });
      await detoxExpect(target).toBeVisible();
      const text = textFromAttributes(await target.getAttributes());
      const expectedText = String(this.resolvePlaceholders(contains));
      if (!text.includes(expectedText)) {
        throw new Error(
          `${stage} expected ${testID} to contain "${expectedText}", received "${text}"`,
        );
      }
    });
  }

  async control(stage, pathName, body, options = {}) {
    await this.runStage(stage, async () => {
      const resolvedBody = this.resolvePlaceholders(body);
      const runner = pathName.startsWith("/e2e/jobs/")
        ? this.controlClient.runJob.bind(this.controlClient)
        : this.controlClient.postJson.bind(this.controlClient);
      const result = await runner(stage, pathName, resolvedBody);
      this.saveControlResult(options, result);
      await this.reattachAfterExternalLaunch(pathName);
    });
  }

  async launch(stage) {
    await this.runStage(stage, async () => {
      await this.controlClient.postJson(
        `${stage}: prepare launch`,
        "/e2e/prepare-app-launch",
        {},
      );
      try {
        await launchApp({ newInstance: true });
      } catch (error) {
        if (!stage.toLowerCase().includes("crash")) throw error;
      }
    });
  }

  async reload(stage) {
    await this.runStage(stage, async () => {
      await disableSynchronizationUntilLaunch();
      await device.terminateApp();
      await launchApp({ newInstance: true });
    });
  }

  async resetAppState(stage) {
    await this.runStage(stage, async () => {
      await this.controlClient.postJson(
        `${stage}: reset local app state`,
        "/e2e/reset-local-app-state",
        {},
      );
      await launchApp({ newInstance: true });
    });
  }

  async tap(stage, testID, expectedResultContains) {
    await this.runStage(stage, async () => {
      const target = await findVisibleTestID(this.controlClient, testID);
      const isInstallAction = shouldDisableSynchronizationForTap(testID);
      if (isInstallAction) {
        await disableSynchronizationUntilLaunch();
      }
      await target.tap();
      if (isInstallAction) {
        await this.waitForInstallActionResult(stage, expectedResultContains);
      }
    });
  }

  async terminate(stage) {
    await this.runStage(stage, async () => {
      await device.terminateApp();
    });
  }

  async typeText(stage, testID, text) {
    await this.runStage(stage, async () => {
      const target = await findVisibleTestID(this.controlClient, testID);
      await target.replaceText(String(this.resolvePlaceholders(text)));
    });
  }

  readStageValue(key) {
    if (Object.hasOwn(this.stageValues, key)) return this.stageValues[key];
    throw new Error(`Missing Detox scenario value: ${key}`);
  }

  resolvePlaceholders(value) {
    if (typeof value === "string") {
      if (value.startsWith("$") && value.indexOf("$", 1) === -1) {
        return this.readStageValue(value.slice(1));
      }
      return value.replace(/\$([A-Za-z0-9_]+)/g, (_, key) =>
        String(this.readStageValue(key)),
      );
    }
    if (Array.isArray(value)) {
      return value.map((item) => this.resolvePlaceholders(item));
    }
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [
          key,
          this.resolvePlaceholders(item),
        ]),
      );
    }
    return value;
  }

  async runStage(stage, operation) {
    console.log(`[detox-stage:start] ${stage}`);
    try {
      await operation();
      console.log(`[detox-stage:done] ${stage}`);
    } catch (error) {
      console.log(`[detox-stage:failed] ${stage}`);
      throw error;
    }
  }

  async waitForInstallActionResult(stage, expectedResultContains) {
    const expectedText =
      typeof expectedResultContains === "string"
        ? String(this.resolvePlaceholders(expectedResultContains))
        : "";
    const resultTarget = await findVisibleTestID(
      this.controlClient,
      "update-action-result",
      { ensureForeground: false },
    );
    const terminalPattern = expectedText
      ? new RegExp(
          `^Update Action Result: .* -> .*${escapeRegExp(expectedText)}.*$`,
        )
      : /^Update Action Result: .* -> (installed|no-update|skipped|error).*$/;

    await waitFor(element(by.text(terminalPattern)))
      .toBeVisible()
      .withTimeout(30000);

    const resultText = textFromAttributes(await resultTarget.getAttributes());
    if (resultText.includes(" -> error ")) {
      throw new Error(`${stage} install action failed: ${resultText}`);
    }
    if (expectedText && !resultText.includes(expectedText)) {
      throw new Error(
        `${stage} expected install result to contain "${expectedText}", received "${resultText}"`,
      );
    }
  }

  saveControlResult(options, result) {
    for (const [key, value] of Object.entries(result)) {
      this.stageValues[key] = value;
    }
    for (const [sourceKey, targetKey] of Object.entries(
      options.saveResultFieldsAs || {},
    )) {
      if (Object.hasOwn(result, sourceKey)) {
        this.stageValues[targetKey] = result[sourceKey];
      }
    }
    if (!options.saveResultAs) return;
    if (typeof result[options.saveResultAs] === "string") {
      this.stageValues[options.saveResultAs] = result[options.saveResultAs];
      return;
    }
    if (typeof result.bundleId === "string") {
      this.stageValues[options.saveResultAs] = result.bundleId;
      return;
    }
    if (typeof result.builtInBundleId === "string") {
      this.stageValues[options.saveResultAs] = result.builtInBundleId;
    }
  }

  async reattachAfterExternalLaunch(pathName) {
    if (!isAndroidRun()) return;
    if (pathName !== "/e2e/wait-for-crash-recovery") return;
    await launchApp({ newInstance: false });
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

module.exports = { DetoxAppDriver };
