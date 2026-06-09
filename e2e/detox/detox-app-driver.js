const { device } = require("detox");
const {
  disableSynchronizationUntilLaunch,
  findVisibleTestID,
  isAndroidRun,
  launchApp,
  rememberActionResultScreenPath,
  textFromAttributes,
  withSynchronizationDisabledForAssertion,
} = require("./detox-page.js");

class DetoxAppDriver {
  constructor(client, initialValues = {}) {
    this.controlClient = client;
    this.stageValues = { ...initialValues };
  }

  async assertText(stage, testID, contains, options = {}) {
    await this.runStage(stage, async () => {
      const expectedText = String(this.resolvePlaceholders(contains));
      await withSynchronizationDisabledForAssertion(async () => {
        const target = await findVisibleTestID(this.controlClient, testID, {
          ensureForeground: options.ensureForeground,
        });
        const text = textFromAttributes(await target.getAttributes());
        if (!text.includes(expectedText)) {
          throw new Error(
            `${stage} expected ${testID} to contain "${expectedText}", received "${text}"`,
          );
        }
      });
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
      const launchState = await this.controlClient.postJson(
        `${stage}: prepare launch`,
        "/e2e/prepare-app-launch",
        {},
      );
      const isCrashLaunch = stage.toLowerCase().includes("crash");
      const shouldReattach =
        isAndroidRun() && launchState.alreadyFocused && !isCrashLaunch;
      try {
        if (shouldReattach) {
          await launchApp({ newInstance: false });
          return;
        }
        await launchApp({ newInstance: true });
      } catch (error) {
        if (!isCrashLaunch) throw error;
      }
    });
  }

  async reload(stage) {
    await this.runStage(stage, async () => {
      await device.terminateApp();
      await this.controlClient.postJson(
        `${stage}: prepare launch`,
        "/e2e/prepare-app-launch",
        {},
      );
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

  async tap(stage, testID) {
    await this.runStage(stage, async () => {
      const isAppReloadAction = testID === "action-reload-app";
      await disableSynchronizationUntilLaunch();
      const target = await findVisibleTestID(this.controlClient, testID);
      await disableSynchronizationUntilLaunch();
      await target.tap();
      rememberActionResultScreenPath(testID);
      await this.reattachAfterAppReloadTap(isAppReloadAction);
    });
  }

  async terminate(stage) {
    await this.runStage(stage, async () => {
      await device.terminateApp();
    });
  }

  async typeText(stage, testID, text) {
    await this.runStage(stage, async () => {
      await disableSynchronizationUntilLaunch();
      const target = await findVisibleTestID(this.controlClient, testID);
      await disableSynchronizationUntilLaunch();
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

  async reattachAfterAppReloadTap(isAppReloadAction) {
    if (!isAndroidRun()) return;
    if (!isAppReloadAction) return;
    await launchApp({ newInstance: false });
  }
}

module.exports = { DetoxAppDriver };
