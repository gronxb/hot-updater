import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";

import {
  type GenerationEventsSnapshot,
  validateGenerationEventsSnapshot,
} from "../../examples/lynx/src/e2eApp/generationEvents.ts";
import { createControlClient } from "../detox/control-client.ts";
import type { JsonObject } from "../detox/control-protocol.ts";
import type {
  DetoxAppDriver,
  DetoxLaunchOptions,
  DetoxTapOptions,
} from "../detox/scenarios/types.ts";
import {
  type DetoxPlatform,
  resolveAppBaseUrl,
  resolveRuntimeConfigUrl,
} from "../detox/scripts/control-server-env.ts";
import type { AndroidRuntimeJournalEvidence } from "./android-runtime-journal.ts";
import {
  GenerationEventLedger,
  type GenerationEventLedgerReceipt,
} from "./generation-event-ledger.ts";
import {
  assertNoManagedResourceEngineErrors,
  evaluateRecoverableAndroidFontDiagnosticEligibility,
  findManagedResourceEngineErrorCodes,
} from "./managed-resource-errors.ts";
import {
  createLynxAndroidLaunchConfigurationArguments,
  createLynxNativeLaunchConfiguration,
  HOT_UPDATER_LYNX_IOS_LAUNCH_CONFIGURATION_PREFIX,
  serializeLynxNativeLaunchConfiguration,
} from "./native-launch-configuration.ts";

type ControlClient = ReturnType<typeof createControlClient>;

type ControlOptions = {
  readonly saveResultAs?: string;
  readonly saveResultFieldsAs?: Readonly<Record<string, string>>;
};

type AndroidRuntimeJournalAcquisitionFailureReason =
  | "screen.reset-request-unavailable"
  | "screen.evidence-request-unavailable"
  | "screen.evidence-receipt-unavailable"
  | "screen.evidence-read-unavailable";

const ACTION_RESULT_FIELDS: Record<string, string> = {
  "action-arm-next-detail-fatal": "updateActionResult",
  "action-arm-next-detail-pending": "updateActionResult",
  "action-capture-stale-authorities": "updateActionResult",
  "action-apply-captured-update": "updateActionResult",
  "action-apply-cohort-input": "cohortActionResult",
  "action-capture-current-channel-update": "updateActionResult",
  "action-install-current-channel-update": "updateActionResult",
  "action-install-fingerprint-update": "updateActionResult",
  "action-install-runtime-channel-update": "updateActionResult",
  "action-fail-pending-detail": "updateActionResult",
  "action-reload-with-pending-detail": "updateActionResult",
  "action-verify-stale-authorities": "updateActionResult",
  "action-verify-managed-navigation-boundary": "updateActionResult",
  "action-exercise-navigation-stack-boundary": "updateActionResult",
  "action-exercise-runtime-journal": "updateActionResult",
  "action-reset-runtime-channel": "channelActionResult",
  "action-restore-initial-cohort": "cohortActionResult",
  "action-set-cohort-qa": "cohortActionResult",
};

const SCREEN_TEXT_FIELDS: Record<string, string> = {
  "channel-action-result": "channelActionResult",
  "cohort-action-result": "cohortActionResult",
  "launch-status-result": "launchStatus",
  "update-action-result": "updateActionResult",
  "runtime-current-channel": "currentChannel",
  "runtime-default-channel": "defaultChannel",
  "runtime-generation-events": "generationEvents",
  "runtime-detail-page-marker": "detailPageMarker",
  "runtime-detail-page-title": "detailPageTitle",
  "runtime-channel-switched": "channelSwitched",
  "runtime-bundle-id": "currentBundleId",
  "runtime-release-state": "currentReleaseId",
  "runtime-current-cohort": "currentCohort",
  "crash-history-count": "crashHistoryCount",
  "runtime-scenario-marker": "runtimeScenarioMarker",
};

const INPUT_TEXT_FIELDS: Record<string, string> = {
  "cohort-input": "cohortInput",
  "runtime-channel-input": "runtimeChannelInput",
};

export class LynxAppDriver implements DetoxAppDriver {
  private readonly controlClient: ControlClient;
  private readonly platform: DetoxPlatform;
  private readonly env: NodeJS.ProcessEnv;
  private androidLaunchLogMarker: string | null = null;
  private activeLaunchGeneration: string | null = null;
  private iosLaunchProcessId: string | null = null;
  private readonly generationEventLedger = new GenerationEventLedger();
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
      if (!Object.hasOwn(SCREEN_TEXT_FIELDS, testID)) {
        throw new Error(`Unsupported Lynx text assertion: ${testID}`);
      }
      const field = SCREEN_TEXT_FIELDS[testID];
      const expected = this.resolvePlaceholders(contains);
      const expectedTexts = (
        Array.isArray(expected) ? expected : [expected]
      ).map(String);
      const deadlineMs = Date.now() + 60_000;
      let last: string | null = null;
      for (;;) {
        const snapshot = (await this.controlClient.postJson(
          `${stage}: read screen state`,
          "/e2e/screen-state",
          {},
        )) as Record<string, unknown>;
        const screenState =
          snapshot.screenState && typeof snapshot.screenState === "object"
            ? (snapshot.screenState as Record<string, unknown>)
            : snapshot;
        const observed = screenState[field];
        last = typeof observed === "string" ? observed : null;
        if (
          typeof observed === "string" &&
          expectedTexts.some((value) =>
            options.exactText === true
              ? observed === value
              : observed.includes(value),
          )
        ) {
          return;
        }
        if (Date.now() >= deadlineMs) {
          throw new Error(
            `${stage} expected ${testID} (${field}) to ${options.exactText === true ? "equal" : "contain"} one of ${JSON.stringify(expectedTexts)}, received ${JSON.stringify(last)}`,
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
      if (
        this.platform === "android" &&
        pathName === "/e2e/jobs/wait-for-android-restart"
      ) {
        await this.assertNoManagedResourceErrors(
          stage,
          typeof resolvedBody.runtimeScenarioMarker === "string"
            ? resolvedBody.runtimeScenarioMarker
            : null,
        );
      }
      this.saveControlResult(options, result as Record<string, unknown>);
    });
  }

  async launch(stage: string, options: DetoxLaunchOptions = {}): Promise<void> {
    await this.runStage(stage, async () => {
      const launchGeneration = randomUUID();
      await this.controlClient.postJson(
        `${stage}: prepare launch`,
        "/e2e/prepare-app-launch",
        { launchGeneration },
      );
      await this.clearOverlayMarker(stage, launchGeneration);
      await this.launchApp({
        expectCrash: options.expectCrash === true,
        launchGeneration,
      });
      if (options.expectCrash === true) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        await this.launchApp({ launchGeneration });
      }
      const runtimeScenarioMarker = await this.waitForOverlayReady(stage);
      await this.assertNoManagedResourceErrors(stage, runtimeScenarioMarker);
    });
  }

  async reload(stage: string): Promise<void> {
    await this.runStage(stage, async () => {
      const launchGeneration = randomUUID();
      this.terminateApp();
      await this.controlClient.postJson(
        `${stage}: prepare launch`,
        "/e2e/prepare-app-launch",
        { launchGeneration },
      );
      await this.clearOverlayMarker(stage, launchGeneration);
      await this.launchApp({ launchGeneration });
      const runtimeScenarioMarker = await this.waitForOverlayReady(stage);
      await this.assertNoManagedResourceErrors(stage, runtimeScenarioMarker);
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

  async tap(
    stage: string,
    testID: string,
    options: DetoxTapOptions = {},
  ): Promise<void> {
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
            ...(actionResultField === "updateActionResult" &&
            options.allowErrorResult !== true
              ? { failSubstrings: [" -> error"] }
              : {}),
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

  async captureGenerationEvents(
    stage: string,
  ): Promise<GenerationEventsSnapshot> {
    let snapshot!: GenerationEventsSnapshot;
    await this.runStage(stage, async () => {
      await this.controlClient.postJson(
        `${stage}: reset generation evidence`,
        "/e2e/screen-state",
        { generationEvents: null, updateActionResult: "idle" },
      );
      await this.controlClient.postJson(
        `${stage}: request generation evidence`,
        "/e2e/pending-action",
        {
          testID: "action-capture-generation-events",
        },
      );
      await this.controlClient.waitForScreenStateField(
        `${stage}: wait for generation evidence`,
        "updateActionResult",
        {
          rejectSubstrings: [" -> error"],
          rejectValues: ["idle"],
        },
      );
      const response = (await this.controlClient.postJson(
        `${stage}: read generation evidence`,
        "/e2e/screen-state",
        {},
      )) as Record<string, unknown>;
      const screenState =
        response.screenState && typeof response.screenState === "object"
          ? (response.screenState as Record<string, unknown>)
          : response;
      if (typeof screenState.generationEvents !== "string") {
        throw new Error("The native generation evidence snapshot is missing");
      }
      snapshot = validateGenerationEventsSnapshot(
        JSON.parse(screenState.generationEvents),
        { allowTruncated: true },
      );
      this.generationEventLedger.merge(stage, snapshot);
      console.log(
        `[lynx-generation-ledger:checkpoint] ${JSON.stringify(this.generationEventLedger.receipt())}`,
      );
    });
    return snapshot;
  }

  runtimeEventLedgerReceipt(): GenerationEventLedgerReceipt {
    return this.generationEventLedger.receipt();
  }

  async captureDiagnosticReceipt<T>(stage: string, testID: string): Promise<T> {
    let receipt!: T;
    await this.runStage(stage, async () => {
      await this.controlClient.postJson(
        `${stage}: reset diagnostic receipt`,
        "/e2e/screen-state",
        { diagnosticReceipt: null, updateActionResult: "idle" },
      );
      await this.controlClient.postJson(
        `${stage}: request diagnostic receipt`,
        "/e2e/pending-action",
        { testID },
      );
      await this.controlClient.waitForScreenStateField(
        `${stage}: wait for diagnostic receipt`,
        "updateActionResult",
        { rejectSubstrings: [" -> error"], rejectValues: ["idle"] },
      );
      const response = (await this.controlClient.postJson(
        `${stage}: read diagnostic receipt`,
        "/e2e/screen-state",
        {},
      )) as Record<string, unknown>;
      const screenState =
        response.screenState && typeof response.screenState === "object"
          ? (response.screenState as Record<string, unknown>)
          : response;
      if (typeof screenState.diagnosticReceipt !== "string") {
        throw new Error("The native diagnostics receipt is missing");
      }
      receipt = JSON.parse(screenState.diagnosticReceipt) as T;
    });
    return receipt;
  }

  get platformName(): DetoxPlatform {
    return this.platform;
  }

  readScenarioString(key: string): string {
    const value = this.readStageValue(key);
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(`Lynx scenario value ${key} must be a non-empty string`);
    }
    return value;
  }

  async reloadManagedGeneration(
    stage: string,
    expectedMarker: string,
  ): Promise<void> {
    await this.runStage(stage, async () => {
      await this.controlClient.postJson(
        `${stage}: reset runtime marker`,
        "/e2e/screen-state",
        { runtimeScenarioMarker: null },
      );
      await this.controlClient.postJson(
        `${stage}: request managed reload`,
        "/e2e/pending-action",
        { testID: "action-reload-app" },
      );
      await this.controlClient.waitForScreenStateField(
        `${stage}: wait for replacement generation`,
        "runtimeScenarioMarker",
        { expectedValue: expectedMarker },
      );
      await this.assertNoManagedResourceErrors(stage, expectedMarker);
    });
  }

  async openDetailPage(stage: string, expectedMarker: string): Promise<void> {
    await this.runStage(stage, async () => {
      await this.controlClient.postJson(
        `${stage}: reset detail observation`,
        "/e2e/screen-state",
        { detailPageMarker: null, detailPageTitle: null },
      );
      await this.controlClient.postJson(
        `${stage}: request detail page`,
        "/e2e/pending-action",
        { testID: "action-open-detail-page" },
      );
      await this.controlClient.waitForScreenStateField(
        `${stage}: wait for detail marker`,
        "detailPageMarker",
        { expectedValue: expectedMarker },
      );
      await this.controlClient.waitForScreenStateField(
        `${stage}: wait for detail params`,
        "detailPageTitle",
        { expectedValue: "Second Page" },
      );
    });
  }

  async closeDetailPage(stage: string): Promise<void> {
    await this.runStage(stage, async () => {
      await this.controlClient.postJson(
        `${stage}: request detail close`,
        "/e2e/pending-action",
        { testID: "action-close-detail-page" },
      );
      await this.controlClient.waitForScreenStateField(
        `${stage}: wait for detail close`,
        "detailPageMarker",
        { expectedValue: "closed" },
      );
    });
  }

  async nativeBack(stage: string): Promise<void> {
    await this.runStage(stage, async () => {
      if (this.platform === "android") {
        this.runOrThrow("adb", [
          "-s",
          this.deviceId(),
          "shell",
          "input",
          "keyevent",
          "BACK",
        ]);
        return;
      }
      const session = `lynx-e2e-${process.pid}`;
      this.runOrThrow("agent-device", [
        "open",
        this.appId(),
        "--platform",
        "ios",
        "--udid",
        this.deviceId(),
        "--foreground",
        "--session",
        session,
        "--json",
      ]);
      this.runOrThrow("agent-device", [
        "gesture",
        "swipe",
        "right-edge",
        "--session",
        session,
        "--json",
      ]);
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
      const field = INPUT_TEXT_FIELDS[testID];
      if (field) {
        await this.controlClient.waitForScreenStateField(
          `${stage}: wait ${field}`,
          field,
          { expectedValue: resolvedText },
        );
      }
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

  ensureInstalled(): void {
    this.installApp();
  }

  uninstallApp(): void {
    this.terminateApp();
    if (this.platform === "ios") {
      spawnSync(
        "xcrun",
        ["simctl", "uninstall", this.deviceId(), this.appId()],
        { encoding: "utf8", env: this.env },
      );
      return;
    }
    spawnSync("adb", ["-s", this.deviceId(), "uninstall", this.appId()], {
      encoding: "utf8",
      env: this.env,
    });
  }

  private installApp(): void {
    if (this.platform === "ios") {
      const binaryPath = this.env.HOT_UPDATER_E2E_IOS_BINARY_PATH;
      if (!binaryPath) {
        throw new Error("HOT_UPDATER_E2E_IOS_BINARY_PATH is required");
      }
      this.runOrThrow("xcrun", ["simctl", "bootstatus", this.deviceId(), "-b"]);
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
    options: { expectCrash?: boolean; launchGeneration?: string } = {},
  ): Promise<void> {
    this.terminateApp();
    this.activeLaunchGeneration = options.launchGeneration ?? null;
    if (this.platform === "android") this.beginAndroidLaunchLogCapture();
    const launchConfiguration = serializeLynxNativeLaunchConfiguration(
      createLynxNativeLaunchConfiguration({
        appBaseURL: resolveAppBaseUrl(this.env),
        channel: "production",
        launchGeneration: options.launchGeneration,
        runtimeConfigURL: resolveRuntimeConfigUrl(this.platform, this.env),
      }),
    );
    if (this.platform === "ios") {
      const output = this.runLaunch(
        "xcrun",
        [
          "simctl",
          "launch",
          this.deviceId(),
          this.appId(),
          "--ota-framework=react",
          "--ota-channel=production",
          `${HOT_UPDATER_LYNX_IOS_LAUNCH_CONFIGURATION_PREFIX}${launchConfiguration}`,
        ],
        options.expectCrash === true,
      );
      const processId = output.match(/:\s*(\d+)\s*$/)?.[1] ?? null;
      this.iosLaunchProcessId = processId;
      if (processId === null && options.expectCrash !== true) {
        throw new Error(
          `xcrun simctl launch succeeded without a process ID: ${JSON.stringify(output)}`,
        );
      }
      return;
    }
    spawnSync("sleep", ["1"]);
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
        ...createLynxAndroidLaunchConfigurationArguments(launchConfiguration),
      ],
      options.expectCrash === true,
    );
  }

  private async clearOverlayMarker(
    stage: string,
    launchGeneration: string,
  ): Promise<void> {
    await this.controlClient.postJson(
      `${stage}: clear overlay marker`,
      "/e2e/screen-state",
      { launchGeneration, runtimeScenarioMarker: null },
    );
  }

  private async waitForOverlayReady(stage: string): Promise<string> {
    try {
      const result = await this.controlClient.waitForScreenStateField(
        `${stage}: wait overlay ready`,
        "runtimeScenarioMarker",
        {
          pollGuard: () => this.assertIOSLaunchProcessAlive(),
          rejectValues: [""],
        },
      );
      return String(result.runtimeScenarioMarker);
    } catch (error) {
      const diagnostics = await this.captureStartupDiagnostics(stage);
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`${message}\nLynx startup diagnostics:\n${diagnostics}`, {
        cause: error,
      });
    }
  }

  private async captureStartupDiagnostics(stage: string): Promise<string> {
    const sections: string[] = [];
    try {
      const state = await this.controlClient.postJson(
        `${stage}: capture failed screen state`,
        "/e2e/screen-state",
        {},
      );
      sections.push(`screen-state ${JSON.stringify(state)}`);
    } catch (error) {
      sections.push(`screen-state unavailable: ${String(error)}`);
    }
    if (this.platform === "ios") {
      const processName = path.basename(
        this.env.HOT_UPDATER_E2E_IOS_BINARY_PATH ?? "SparklingGoE2E.app",
        ".app",
      );
      sections.push(
        this.captureCommand("ios-processes", "xcrun", [
          "simctl",
          "spawn",
          this.deviceId(),
          "/bin/ps",
          "-axo",
          "pid=,state=,command=",
        ]).text,
        this.captureCommand("ios-unified-log", "xcrun", [
          "simctl",
          "spawn",
          this.deviceId(),
          "log",
          "show",
          "--last",
          "2m",
          "--style",
          "compact",
          "--predicate",
          `process == "${processName}" AND (messageType == error OR messageType == fault OR eventMessage CONTAINS[c] "hot-updater" OR eventMessage CONTAINS "onErrorOccurred" OR eventMessage CONTAINS "FirstScreen" OR eventMessage CONTAINS "onPageChanged" OR (eventMessage CONTAINS "NativeModule" AND eventMessage CONTAINS "HotUpdaterLynx") OR eventMessage CONTAINS "Public Lynx host failed")`,
        ]).text,
      );
    } else {
      const pid = this.captureCommand("android-pid", "adb", [
        "-s",
        this.deviceId(),
        "shell",
        "pidof",
        this.appId(),
      ]);
      sections.push(
        pid.text,
        this.captureCommand("android-process", "adb", [
          "-s",
          this.deviceId(),
          "shell",
          "dumpsys",
          "activity",
          "processes",
          this.appId(),
        ]).text,
        this.captureAndroidLaunchLogs().text,
      );
    }
    return sections.join("\n");
  }

  private assertIOSLaunchProcessAlive(): void {
    if (this.platform !== "ios" || this.iosLaunchProcessId === null) return;
    const result = this.captureCommand("ios-launch-process", "xcrun", [
      "simctl",
      "spawn",
      this.deviceId(),
      "/bin/kill",
      "-0",
      this.iosLaunchProcessId,
    ]);
    if (result.status === 0) return;
    if (/No such process/i.test(result.text)) {
      throw new Error(
        `iOS app process ${this.iosLaunchProcessId} exited while waiting for runtimeScenarioMarker\n${result.text}`,
      );
    }
    throw new Error(
      `Could not inspect iOS app process ${this.iosLaunchProcessId} while waiting for runtimeScenarioMarker\n${result.text}`,
    );
  }

  private async assertNoManagedResourceErrors(
    stage: string,
    expectedRuntimeScenarioMarker: string | null,
  ): Promise<void> {
    if (this.platform !== "android") return;
    const logResult = this.captureAndroidLaunchLogs();
    if (logResult.status !== 0) {
      throw new Error(
        `Could not inspect managed Lynx resources: ${logResult.text}`,
      );
    }
    const preliminaryCodes = findManagedResourceEngineErrorCodes(
      logResult.logsSinceLaunch,
      null,
    );
    if (!preliminaryCodes.includes(302) || preliminaryCodes.includes(301)) {
      try {
        assertNoManagedResourceEngineErrors(logResult.logsSinceLaunch, null);
      } catch (error) {
        if (
          preliminaryCodes.includes(302) &&
          preliminaryCodes.includes(301) &&
          error instanceof Error
        ) {
          throw new Error(
            `${error.message}; Android journal recovery: reason=log.code-301-present`,
          );
        }
        throw error;
      }
      return;
    }
    let processId: string;
    try {
      processId = this.readAndroidProcessId();
    } catch {
      throw new Error(
        "Could not inspect managed Lynx resources before reading runtime evidence; Android journal recovery: reason=log.current-process-id-unavailable",
      );
    }
    const eligibility = evaluateRecoverableAndroidFontDiagnosticEligibility(
      logResult.logsSinceLaunch,
      processId,
    );
    if (!eligibility.eligible) {
      assertNoManagedResourceEngineErrors(
        logResult.logsSinceLaunch,
        null,
        eligibility,
      );
      return;
    }
    if (!expectedRuntimeScenarioMarker) {
      throw new Error(
        "Could not inspect managed Lynx resources: expected runtime marker is unavailable; Android journal recovery: reason=screen.expected-runtime-marker",
      );
    }
    const journalEvidence = await this.captureAndroidRuntimeJournalEvidence(
      stage,
      processId,
      expectedRuntimeScenarioMarker,
    );
    let evidenceProcessId: string;
    try {
      evidenceProcessId = this.readAndroidProcessId();
    } catch {
      throw new Error(
        "Could not inspect managed Lynx resources after reading runtime evidence; Android journal recovery: reason=screen.current-process-id-unavailable",
      );
    }
    if (evidenceProcessId !== processId) {
      throw new Error(
        "Could not inspect managed Lynx resources: Android process changed while reading runtime evidence; Android journal recovery: reason=screen.current-process-id-changed",
      );
    }
    assertNoManagedResourceEngineErrors(
      logResult.logsSinceLaunch,
      journalEvidence,
      eligibility,
    );
  }

  private readAndroidProcessId(): string {
    const result = this.captureCommand("android-pid", "adb", [
      "-s",
      this.deviceId(),
      "shell",
      "pidof",
      this.appId(),
    ]);
    const processId = result.stdout.trim();
    if (result.status !== 0 || !/^[1-9][0-9]*$/.test(processId)) {
      throw new Error(
        `Could not inspect managed Lynx resources: ${result.text}`,
      );
    }
    return processId;
  }

  private async captureAndroidRuntimeJournalEvidence(
    stage: string,
    currentProcessId: string,
    expectedRuntimeScenarioMarker: string,
  ): Promise<AndroidRuntimeJournalEvidence> {
    await this.captureAndroidRuntimeJournalAcquisitionStep(
      "screen.reset-request-unavailable",
      () =>
        this.controlClient.postJson(
          `${stage}: reset runtime journal evidence`,
          "/e2e/screen-state",
          { generationEvents: null, updateActionResult: "idle" },
        ),
    );
    await this.captureAndroidRuntimeJournalAcquisitionStep(
      "screen.evidence-request-unavailable",
      () =>
        this.controlClient.postJson(
          `${stage}: request runtime journal evidence`,
          "/e2e/pending-action",
          { testID: "action-capture-generation-events" },
        ),
    );
    const generationEventsResponse =
      await this.captureAndroidRuntimeJournalAcquisitionStep(
        "screen.evidence-receipt-unavailable",
        () =>
          this.controlClient.waitForScreenStateField(
            `${stage}: wait for runtime journal evidence`,
            "generationEvents",
          ),
      );
    const snapshot = validateGenerationEventsSnapshot(
      JSON.parse(String(generationEventsResponse.generationEvents)),
      { allowTruncated: true },
    );
    const actionResultResponse =
      await this.captureAndroidRuntimeJournalAcquisitionStep(
        "screen.evidence-receipt-unavailable",
        () =>
          this.controlClient.waitForScreenStateField(
            `${stage}: wait for runtime journal receipt`,
            "updateActionResult",
            {
              expectedValue: `generation-events -> ${snapshot.latestSequence}`,
            },
          ),
      );
    const screenStateResponse =
      await this.captureAndroidRuntimeJournalAcquisitionStep(
        "screen.evidence-read-unavailable",
        () =>
          this.controlClient.postJson(
            `${stage}: read runtime journal evidence`,
            "/e2e/screen-state",
            {},
          ),
      );
    const journal = this.captureCommand(
      "android-runtime-journal",
      "adb",
      [
        "-s",
        this.deviceId(),
        "shell",
        "run-as",
        this.appId(),
        "cat",
        "files/hot-updater-lynx/runtime-events/events.json",
      ],
      20 * 1024 * 1024,
    );
    if (journal.status !== 0 || journal.stdout.length === 0) {
      throw new Error(
        "Could not inspect managed Lynx runtime journal; Android journal recovery: reason=journal.read-unavailable",
      );
    }
    return {
      actionResultResponse,
      currentProcessId,
      expectedLaunchGeneration: this.activeLaunchGeneration,
      expectedRuntimeScenarioMarker,
      runtimeJournalUtf8: journal.stdout,
      screenStateResponse,
    };
  }

  private async captureAndroidRuntimeJournalAcquisitionStep<T>(
    reason: AndroidRuntimeJournalAcquisitionFailureReason,
    operation: () => Promise<T>,
  ): Promise<T> {
    try {
      return await operation();
    } catch {
      throw new Error(
        `Could not acquire managed Lynx runtime journal evidence; Android journal recovery: reason=${reason}`,
      );
    }
  }

  private beginAndroidLaunchLogCapture(): void {
    const marker = `HotUpdaterE2ELaunch:${randomUUID()}`;
    const markerResult = this.captureCommand("android-logcat-marker", "adb", [
      "-s",
      this.deviceId(),
      "shell",
      "log",
      "-t",
      "HotUpdaterE2E",
      marker,
    ]);
    if (markerResult.status !== 0) {
      throw new Error(
        `Could not establish Android launch logs: ${markerResult.text}`,
      );
    }
    this.androidLaunchLogMarker = marker;
  }

  private captureAndroidLaunchLogs(): ReturnType<
    LynxAppDriver["captureCommand"]
  > & { readonly logsSinceLaunch: string } {
    const marker = this.androidLaunchLogMarker;
    if (!marker) {
      throw new Error(
        "Could not inspect managed Lynx resources: no launch marker",
      );
    }
    const result = this.captureCommand("android-logcat", "adb", [
      "-s",
      this.deviceId(),
      "logcat",
      "-d",
    ]);
    const markerIndex = result.stdout.indexOf(marker);
    if (result.status === 0 && markerIndex < 0) {
      return {
        ...result,
        status: 1,
        logsSinceLaunch: "",
        text: `${result.text}\nAndroid launch log marker was not found`,
      };
    }
    return {
      ...result,
      logsSinceLaunch:
        markerIndex < 0 ? "" : result.stdout.slice(markerIndex + marker.length),
    };
  }

  private captureCommand(
    label: string,
    command: string,
    args: readonly string[],
    maxBuffer = 512 * 1024,
  ): {
    readonly status: number | null;
    readonly stdout: string;
    readonly text: string;
  } {
    try {
      const result = spawnSync(command, args, {
        encoding: "utf8",
        env: this.env,
        maxBuffer,
        timeout: 5000,
      });
      const stdout = result.stdout ?? "";
      const commandError = result.error ? `\n${String(result.error)}` : "";
      const output = `${stdout}${result.stderr ?? ""}${commandError}`;
      return {
        status: result.status,
        stdout,
        text: `${label} (status ${String(result.status)}): ${output.slice(-64 * 1024)}`,
      };
    } catch (error) {
      return {
        status: null,
        stdout: "",
        text: `${label} unavailable: ${String(error)}`,
      };
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
  ): string {
    if (expectCrash) {
      const result = spawnSync(command, args, {
        encoding: "utf8",
        env: this.env,
      });
      return result.stdout ?? "";
    }
    return this.runOrThrow(command, args);
  }

  private runOrThrow(command: string, args: readonly string[]): string {
    const result = spawnSync(command, args, {
      encoding: "utf8",
      env: this.env,
    });
    if (result.status !== 0) {
      throw new Error(
        `${command} ${args.join(" ")} failed: ${result.stderr || result.stdout || result.status}`,
      );
    }
    return result.stdout ?? "";
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
}
