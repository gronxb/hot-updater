import { spawnSync } from "node:child_process";

import { createControlClient } from "../detox/control-client.ts";
import type { JsonObject } from "../detox/control-protocol.ts";
import type { DetoxAppDriver } from "../detox/scenarios/types.ts";
import type { DetoxPlatform } from "../detox/scripts/control-server-env.ts";

type ControlClient = ReturnType<typeof createControlClient>;

type ControlOptions = {
  readonly saveResultAs?: string;
  readonly saveResultFieldsAs?: Readonly<Record<string, string>>;
};

const ACTION_RESULT_FIELDS: Record<string, string> = {
  "action-apply-captured-update": "updateActionResult",
  "action-apply-cohort-input": "cohortActionResult",
  "action-capture-current-channel-update": "updateActionResult",
  "action-install-current-channel-update": "updateActionResult",
  "action-install-fingerprint-update": "updateActionResult",
  "action-install-runtime-channel-update": "updateActionResult",
  "action-reset-runtime-channel": "channelActionResult",
  "action-restore-initial-cohort": "cohortActionResult",
  "action-set-cohort-qa": "cohortActionResult",
};

export class LynxAppDriver implements DetoxAppDriver {
  private readonly controlClient: ControlClient;
  private readonly platform: DetoxPlatform;
  private readonly env: NodeJS.ProcessEnv;
  private stageValues: Record<string, unknown>;

  constructor(
    controlClient: ControlClient,
    platform: DetoxPlatform,
    env: NodeJS.ProcessEnv,
    initialValues: Record<string, unknown> = {},
  ) {
    this.controlClient = controlClient;
    this.platform = platform;
    this.env = env;
    this.stageValues = { ...initialValues };
  }

  async assertText(
    stage: string,
    testID: string,
    contains: string | readonly string[],
    options: { exactText?: boolean } = {},
  ): Promise<void> {
    await this.runStage(stage, async () => {
      const expected = this.resolvePlaceholders(contains);
      const expectedTexts = (Array.isArray(expected) ? expected : [expected]).map(
        String,
      );
      if (options.exactText === true) {
        await this.waitForExpectedActionResultText(stage, testID, expectedTexts[0]);
        return;
      }
      const snapshot = (await this.controlClient.postJson(
        `${stage}: read screen state`,
        "/e2e/screen-state",
        {},
      )) as Record<string, unknown>;
      const text = JSON.stringify(snapshot);
      if (!expectedTexts.some((value) => text.includes(value))) {
        throw new Error(
          `${stage} expected ${testID} to contain one of ${JSON.stringify(expectedTexts)}, received ${text}`,
        );
      }
    });
  }

  async control(
    stage: string,
    pathName: string,
    body: JsonObject = {},
    options: ControlOptions = {},
  ): Promise<void> {
    await this.runStage(stage, async () => {
      const resolvedBody = this.resolvePlaceholders(body) as JsonObject;
      const runner = pathName.startsWith("/e2e/jobs/")
        ? this.controlClient.runJob.bind(this.controlClient)
        : this.controlClient.postJson.bind(this.controlClient);
      const result = await runner(stage, pathName, resolvedBody);
      this.saveControlResult(options, result as Record<string, unknown>);
    });
  }

  async launch(stage: string): Promise<void> {
    await this.runStage(stage, async () => {
      await this.controlClient.postJson(
        `${stage}: prepare launch`,
        "/e2e/prepare-app-launch",
        {},
      );
      this.launchApp();
    });
  }

  async reload(stage: string): Promise<void> {
    await this.runStage(stage, async () => {
      this.terminateApp();
      await this.controlClient.postJson(
        `${stage}: prepare launch`,
        "/e2e/prepare-app-launch",
        {},
      );
      this.launchApp();
    });
  }

  async resetAppState(stage: string): Promise<void> {
    await this.runStage(stage, async () => {
      await this.controlClient.postJson(
        `${stage}: reset local app state`,
        "/e2e/reset-local-app-state",
        {},
      );
      this.launchApp();
    });
  }

  async tap(stage: string, testID: string): Promise<void> {
    await this.runStage(stage, async () => {
      const actionResultField = ACTION_RESULT_FIELDS[testID];
      if (actionResultField) {
        await this.controlClient.postJson(
          `${stage}: reset ${actionResultField}`,
          "/e2e/screen-state",
          { [actionResultField]: "idle" },
        );
      }
      this.tapTestId(testID);
      if (actionResultField) {
        await this.controlClient.waitForScreenStateField(
          `${stage}: wait ${actionResultField}`,
          actionResultField,
          {
            rejectSubstrings: [" -> checking"],
            rejectValues: ["idle"],
          },
        );
      }
    });
  }

  async terminate(stage: string): Promise<void> {
    await this.runStage(stage, async () => {
      this.terminateApp();
    });
  }

  async typeText(stage: string, testID: string, text: string): Promise<void> {
    await this.runStage(stage, async () => {
      const resolvedText = String(this.resolvePlaceholders(text));
      this.tapTestId(testID);
      this.typeIntoFocused(resolvedText);
    });
  }

  async verifyConsoleInsights(sinceMs: number): Promise<unknown> {
    return this.controlClient.postJson(
      "verify Console Insights",
      "/e2e/verify-console-insights",
      { sinceMs },
    );
  }

  private appId(): string {
    if (this.platform === "ios") {
      return (
        this.env.HOT_UPDATER_E2E_IOS_APP_ID ??
        this.env.HOT_UPDATER_E2E_APP_ID ??
        "com.hotupdater.lynxexample"
      );
    }
    return this.env.HOT_UPDATER_E2E_APP_ID ?? "com.hotupdater.lynxexample";
  }

  private launchApp(): void {
    if (this.platform === "ios") {
      this.runOrThrow("xcrun", ["simctl", "launch", "booted", this.appId()]);
      return;
    }
    this.runOrThrow("adb", [
      "shell",
      "am",
      "start",
      "-n",
      `${this.appId()}/.OtaActivity`,
    ]);
  }

  private terminateApp(): void {
    if (this.platform === "ios") {
      this.runOrThrow("xcrun", ["simctl", "terminate", "booted", this.appId()]);
      return;
    }
    this.runOrThrow("adb", ["shell", "am", "force-stop", this.appId()]);
  }

  private tapTestId(testID: string): void {
    throw new Error(
      `Lynx E2E tap for testID "${testID}" is not wired yet. The scenario runner, control server, and ${this.platform} app launch path are ready.`,
    );
  }

  private typeIntoFocused(text: string): void {
    if (this.platform === "android") {
      this.runOrThrow("adb", ["shell", "input", "text", text.replaceAll(" ", "%s")]);
      return;
    }
    throw new Error(`Lynx E2E typeText is not wired on iOS yet: ${text}`);
  }

  private runOrThrow(command: string, args: readonly string[]): void {
    const result = spawnSync(command, args, {
      encoding: "utf8",
      env: this.env,
    });
    if (result.status !== 0) {
      throw new Error(
        `${command} ${args.join(" ")} failed: ${result.stderr || result.stdout || result.status}`,
      );
    }
  }

  private readStageValue(key: string): unknown {
    if (Object.hasOwn(this.stageValues, key)) return this.stageValues[key];
    throw new Error(`Missing Lynx scenario value: ${key}`);
  }

  private resolvePlaceholders(value: unknown): unknown {
    if (typeof value === "string") {
      if (value.startsWith("$") && value.indexOf("$", 1) === -1) {
        return this.readStageValue(value.slice(1));
      }
      return value.replace(/\$([A-Za-z0-9_]+)/g, (_, key: string) =>
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

  private async runStage(stage: string, operation: () => Promise<void>): Promise<void> {
    console.log(`[lynx-stage:start] ${stage}`);
    try {
      await operation();
      console.log(`[lynx-stage:done] ${stage}`);
    } catch (error) {
      console.log(`[lynx-stage:failed] ${stage}`);
      throw error;
    }
  }

  private saveControlResult(
    options: ControlOptions,
    result: Record<string, unknown>,
  ): void {
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

  private async waitForExpectedActionResultText(
    stage: string,
    testID: string,
    expectedText: string,
  ): Promise<void> {
    const fieldName = ACTION_RESULT_FIELDS[testID] ?? testID;
    await this.controlClient.waitForScreenStateField(
      `${stage}: wait ${fieldName} exact`,
      fieldName,
      {
        expectedValue: expectedText,
        rejectSubstrings: [" -> checking"],
        rejectValues: ["idle"],
      },
    );
  }
}
