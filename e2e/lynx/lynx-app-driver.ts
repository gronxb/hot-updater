import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { createControlClient } from "../detox/control-client.ts";
import type { JsonObject } from "../detox/control-protocol.ts";
import type {
  DetoxAppDriver,
  DetoxLaunchOptions,
} from "../detox/scenarios/types.ts";
import type { DetoxPlatform } from "../detox/scripts/control-server-env.ts";
import { compileLynxE2eEmbedded } from "./embedded-bundle.ts";

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

const ACTION_RESULT_TEXT_FIELDS: Record<string, string> = {
  "channel-action-result": "channelActionResult",
  "cohort-action-result": "cohortActionResult",
  "launch-status-result": "launchStatus",
  "update-action-result": "updateActionResult",
};

export class LynxAppDriver implements DetoxAppDriver {
  private readonly controlClient: ControlClient;
  private readonly platform: DetoxPlatform;
  private readonly env: NodeJS.ProcessEnv;
  private stageValues: Record<string, unknown>;
  private overlayDirPromise: Promise<string> | null = null;

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
      const expectedTexts = (
        Array.isArray(expected) ? expected : [expected]
      ).map(String);
      if (options.exactText === true) {
        await this.waitForExpectedActionResultText(
          stage,
          testID,
          expectedTexts[0],
        );
        return;
      }
      const deadlineMs = Date.now() + 60_000;
      let last = "";
      for (;;) {
        const snapshot = (await this.controlClient.postJson(
          `${stage}: read screen state`,
          "/e2e/screen-state",
          {},
        )) as Record<string, unknown>;
        last = JSON.stringify(snapshot);
        if (expectedTexts.some((value) => last.includes(value))) {
          return;
        }
        if (Date.now() >= deadlineMs) {
          throw new Error(
            `${stage} expected ${testID} to contain one of ${JSON.stringify(expectedTexts)}, received ${last}`,
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
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

  async launch(stage: string, options: DetoxLaunchOptions = {}): Promise<void> {
    await this.runStage(stage, async () => {
      await this.controlClient.postJson(
        `${stage}: prepare launch`,
        "/e2e/prepare-app-launch",
        {},
      );
      await this.launchApp({ expectCrash: options.expectCrash === true });
      if (options.expectCrash === true) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        await this.launchApp();
      }
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
      await this.launchApp();
    });
  }

  async resetAppState(stage: string): Promise<void> {
    await this.runStage(stage, async () => {
      await this.controlClient.postJson(
        `${stage}: reset local app state`,
        "/e2e/reset-local-app-state",
        {},
      );
      await this.launchApp();
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
      await this.controlClient.postJson(
        `${stage}: queue ${testID}`,
        "/e2e/pending-action",
        {
          testID,
        },
      );
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
      await this.controlClient.postJson(
        `${stage}: queue ${testID}`,
        "/e2e/pending-action",
        {
          testID,
          text: resolvedText,
        },
      );
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

  private deviceId(): string {
    if (this.platform === "ios") {
      return (
        this.env.HOT_UPDATER_E2E_DEVICE_ID ??
        this.env.HOT_UPDATER_E2E_IOS_SIMULATOR_NAME ??
        "booted"
      );
    }
    return (
      this.env.HOT_UPDATER_E2E_ANDROID_SERIAL ??
      this.env.HOT_UPDATER_E2E_DEVICE_ID ??
      "emulator-5554"
    );
  }

  private exampleDir(): string {
    const exampleDir = this.env.HOT_UPDATER_E2E_ENV_TARGET_DIR;
    if (!exampleDir) {
      throw new Error("HOT_UPDATER_E2E_ENV_TARGET_DIR is required");
    }
    return exampleDir;
  }

  ensureInstalled(): void {
    this.installApp();
  }

  prepareOverlay(): Promise<string> {
    this.overlayDirPromise ??= compileLynxE2eEmbedded({
      exampleDir: this.exampleDir(),
      platform: this.platform,
      env: this.env,
    });
    return this.overlayDirPromise;
  }

  private installApp(): void {
    if (this.platform === "ios") {
      const binaryPath = this.env.HOT_UPDATER_E2E_IOS_BINARY_PATH;
      if (!binaryPath) {
        throw new Error("HOT_UPDATER_E2E_IOS_BINARY_PATH is required");
      }
      this.runOrThrow("xcrun", [
        "simctl",
        "install",
        this.deviceId(),
        binaryPath,
      ]);
      return;
    }
    const apkPath =
      this.env.HOT_UPDATER_E2E_ANDROID_BINARY_PATH ??
      this.env.HOT_UPDATER_E2E_ANDROID_APK_PATH;
    if (!apkPath) {
      throw new Error("HOT_UPDATER_E2E_ANDROID_BINARY_PATH is required");
    }
    this.runOrThrow("adb", ["-s", this.deviceId(), "install", "-r", apkPath]);
  }

  private async launchApp(
    options: { expectCrash?: boolean } = {},
  ): Promise<void> {
    this.terminateApp();
    const embeddedDir = await this.prepareOverlay();
    if (this.platform === "ios") {
      this.runLaunch(
        "xcrun",
        [
          "simctl",
          "launch",
          this.deviceId(),
          this.appId(),
          "--ota-framework=react",
          "--ota-channel=production",
          `--ota-embedded-dir=${embeddedDir}`,
        ],
        options.expectCrash === true,
      );
      return;
    }
    const deviceEmbeddedDir = this.installAndroidOverlay(embeddedDir);
    this.runOrThrow("adb", ["-s", this.deviceId(), "logcat", "-c"]);
    this.runLaunch(
      "adb",
      [
        "-s",
        this.deviceId(),
        "shell",
        "am",
        "start",
        "-S",
        "-n",
        `${this.appId()}/.OtaActivity`,
        "--es",
        "framework",
        "react",
        "--es",
        "channel",
        "production",
        "--es",
        "embeddedDir",
        deviceEmbeddedDir,
      ],
      options.expectCrash === true,
    );
    if (options.expectCrash !== true) {
      this.assertAndroidOverlayLoaded();
    }
  }

  private installAndroidOverlay(localDir: string): string {
    const remoteRel = "files/e2e-embedded";
    this.runOrThrow("adb", [
      "-s",
      this.deviceId(),
      "shell",
      "run-as",
      this.appId(),
      "rm",
      "-rf",
      remoteRel,
    ]);
    this.runOrThrow("adb", [
      "-s",
      this.deviceId(),
      "shell",
      "run-as",
      this.appId(),
      "mkdir",
      "-p",
      remoteRel,
    ]);
    for (const rel of this.listRelativeFiles(localDir)) {
      const parent = path.posix.dirname(rel);
      if (parent !== ".") {
        this.runOrThrow("adb", [
          "-s",
          this.deviceId(),
          "shell",
          "run-as",
          this.appId(),
          "mkdir",
          "-p",
          `${remoteRel}/${parent}`,
        ]);
      }
      const pushed = spawnSync(
        "adb",
        [
          "-s",
          this.deviceId(),
          "shell",
          "-T",
          "run-as",
          this.appId(),
          "sh",
          "-c",
          `cat > ${remoteRel}/${rel}`,
        ],
        {
          encoding: "buffer",
          input: readFileSync(path.join(localDir, rel)),
          timeout: 15_000,
        },
      );
      if (pushed.status !== 0) {
        throw new Error(
          `overlay copy ${rel} failed: ${pushed.stderr?.toString() || pushed.status}`,
        );
      }
    }
    this.runOrThrow("adb", [
      "-s",
      this.deviceId(),
      "shell",
      "run-as",
      this.appId(),
      "test",
      "-f",
      `${remoteRel}/manifest.json`,
    ]);
    return "e2e-embedded";
  }

  private listRelativeFiles(root: string): string[] {
    const names: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const full = path.join(dir, entry);
        const stat = statSync(full);
        if (stat.isDirectory()) {
          walk(full);
          continue;
        }
        names.push(path.relative(root, full).split(path.sep).join("/"));
      }
    };
    walk(root);
    return names;
  }

  private assertAndroidOverlayLoaded(): void {
    spawnSync("sleep", ["1"]);
    const logs = spawnSync(
      "adb",
      ["-s", this.deviceId(), "logcat", "-d", "-s", "HotUpdaterLynx:I"],
      { encoding: "utf8" },
    );
    const out = `${logs.stdout || ""}\n${logs.stderr || ""}`;
    if (!out.includes("absoluteDir=true") && !out.includes("manifest=true")) {
      throw new Error(`Android overlay not loaded by host: ${out.slice(-2000)}`);
    }
  }

  private terminateApp(): void {
    if (this.platform === "ios") {
      spawnSync(
        "xcrun",
        ["simctl", "terminate", this.deviceId(), this.appId()],
        { encoding: "utf8", env: this.env },
      );
      return;
    }
    spawnSync(
      "adb",
      ["-s", this.deviceId(), "shell", "am", "force-stop", this.appId()],
      { encoding: "utf8", env: this.env },
    );
  }

  private runLaunch(
    command: string,
    args: readonly string[],
    expectCrash: boolean,
  ): void {
    if (expectCrash) {
      spawnSync(command, args, {
        encoding: "utf8",
        env: this.env,
      });
      return;
    }
    this.runOrThrow(command, args);
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

  private async runStage(
    stage: string,
    operation: () => Promise<void>,
  ): Promise<void> {
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
    const fieldName = ACTION_RESULT_TEXT_FIELDS[testID];
    if (!fieldName) return;
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
