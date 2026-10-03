import { setTimeout as sleep } from "node:timers/promises";

import type { Device, OpenAppOptions } from "@e2e-dev/mobile";
import type { Locator, Screen } from "e2e";

import type { ControlClient, JsonObject } from "../shared/control-client.ts";
import type {
  ScenarioAppDriver,
  AssertTextOptions,
  ControlOptions,
  LaunchOptions,
} from "../shared/scenarios/types.ts";
import {
  E2E_SCREEN_URLS,
  TEST_ID_SCREEN_PATHS,
} from "../shared/screen-routes/index.js";
import { RAW_TEXT_ATTRIBUTE } from "./engine.ts";
import type { IosAlert } from "./ios-alert.ts";

const inputFields: Record<string, string> = {
  "cohort-input": "cohortInput",
  "runtime-channel-input": "runtimeChannelInput",
};
const actionFields: Record<string, string> = {
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
const resultFields: Record<string, string> = {
  "channel-action-result": "channelActionResult",
  "cohort-action-result": "cohortActionResult",
  "update-action-result": "updateActionResult",
};

type DriverOptions = {
  readonly client: Pick<
    ControlClient,
    "postJson" | "runJob" | "waitForScreenStateField"
  >;
  readonly device: Pick<Device, "openApp" | "openLink">;
  readonly screen: Pick<Screen, "getByTestId" | "getByRole">;
  readonly iosAlert: { get(): Promise<IosAlert | null> };
  readonly appId: string;
  readonly platform: "ios" | "android";
  readonly signal: AbortSignal;
  readonly launchArguments?: readonly string[];
  readonly initialValues?: JsonObject;
  readonly assertionTimeoutMs?: number;
};

export class MobileAppDriver implements ScenarioAppDriver {
  private readonly values: JsonObject;
  private activeScreenPath?: string;
  private pendingRecovery?: "crash" | "reload";
  private pendingLaunchFailure = false;
  private verifiedLaunchFailures = 0;

  get expectedLaunchFailures() {
    return this.verifiedLaunchFailures;
  }

  constructor(private readonly options: DriverOptions) {
    this.values = { ...options.initialValues };
  }

  async assertText(
    stage: string,
    testID: string,
    contains: string | readonly string[],
    options: AssertTextOptions = {},
  ) {
    await this.runStage(stage, async () => {
      const resolved = this.resolve(contains);
      const expected = (Array.isArray(resolved) ? resolved : [resolved]).map(
        String,
      );
      const field = resultFields[testID];
      if (options.exactText && field) {
        await this.options.client.waitForScreenStateField(
          `${stage}: wait ${field} exact`,
          field,
          {
            expectedValue: expected[0],
            rejectValues: ["idle"],
            rejectSubstrings: [" -> checking"],
          },
        );
      }
      const target = await this.findVisible(testID, options.ensureForeground);
      const timeoutMs = this.options.assertionTimeoutMs ?? 30_000;
      const deadline = Date.now() + timeoutMs;
      let actual: string | null;
      do {
        this.options.signal.throwIfAborted();
        actual = await target.getAttribute(RAW_TEXT_ATTRIBUTE);
        if (
          actual !== null &&
          (options.exactText
            ? actual === expected[0]
            : expected.some((text) => actual!.includes(text)))
        )
          return;
        if (Date.now() >= deadline) break;
        await sleep(100, undefined, { signal: this.options.signal });
      } while (Date.now() <= deadline);
      throw new Error(
        `${stage} expected ${testID} ${options.exactText ? "to equal" : "to contain one of"} ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`,
      );
    });
  }

  async control(
    stage: string,
    pathName: string,
    body?: JsonObject,
    options: ControlOptions = {},
  ) {
    await this.runStage(stage, async () => {
      const resolved = this.resolve(body) as JsonObject | undefined;
      const client = this.options.client;
      const result = await (pathName.startsWith("/e2e/jobs/")
        ? client.runJob(stage, pathName, resolved)
        : client.postJson(stage, pathName, resolved));
      Object.assign(this.values, result);
      for (const [source, target] of Object.entries(
        options.saveResultFieldsAs ?? {},
      )) {
        if (Object.hasOwn(result, source)) this.values[target] = result[source];
      }
      if (options.saveResultAs) {
        const value =
          result[options.saveResultAs] ??
          result.bundleId ??
          result.builtInBundleId;
        if (typeof value === "string")
          this.values[options.saveResultAs] = value;
      }
      // Observe native recovery before any navigation can start a dead app.
      if (
        (this.pendingRecovery === "crash" &&
          pathName === "/e2e/wait-for-crash-recovery") ||
        (this.pendingRecovery === "reload" &&
          pathName === "/e2e/jobs/wait-for-metadata" &&
          resolved?.verificationPending === false)
      ) {
        if (this.pendingLaunchFailure) this.verifiedLaunchFailures += 1;
        this.pendingLaunchFailure = false;
        this.pendingRecovery = undefined;
        this.activeScreenPath = undefined;
      }
    });
  }

  async launch(stage: string, options: LaunchOptions = {}) {
    await this.runStage(stage, async () => {
      const launchState = await this.options.client.postJson(
        `${stage}: prepare launch`,
        "/e2e/prepare-app-launch",
        {},
      );
      const recovering = options.expectCrash || options.allowDisconnect;
      this.pendingLaunchFailure = false;
      this.pendingRecovery = options.expectCrash
        ? "crash"
        : options.allowDisconnect
          ? "reload"
          : undefined;
      try {
        await this.openApp({
          relaunch: !(
            this.options.platform === "android" &&
            launchState.alreadyFocused &&
            !recovering
          ),
        });
      } catch (error) {
        this.options.signal.throwIfAborted();
        if (!recovering) throw error;
        this.pendingLaunchFailure = true;
        // The next control assertions must establish recovery; no UI action is
        // permitted to hide this disconnect by opening the app again.
        console.log(`[e2e-launch:awaiting-recovery] ${String(error)}`);
      }
    });
  }

  async reload(stage: string) {
    await this.runStage(stage, async () => {
      await this.options.client.postJson(
        `${stage}: terminate app`,
        "/e2e/terminate-app",
        {},
      );
      await this.options.client.postJson(
        `${stage}: prepare launch`,
        "/e2e/prepare-app-launch",
        {},
      );
      await this.openApp({ relaunch: true });
    });
  }

  async resetAppState(stage: string) {
    await this.runStage(stage, async () => {
      await this.options.client.postJson(
        `${stage}: reset local app state`,
        "/e2e/reset-local-app-state",
        {},
      );
      await this.openApp({ relaunch: true });
    });
  }

  async tap(stage: string, testID: string) {
    await this.runStage(stage, async () => {
      const field = actionFields[testID];
      if (field) {
        await this.options.client.postJson(
          `${stage}: reset ${field}`,
          "/e2e/screen-state",
          { [field]: "idle" },
        );
        await this.findVisible(testID, true, true);
        let confirmed = false;
        await this.options.client.waitForScreenStateField(
          `${stage}: wait ${field}`,
          field,
          {
            ...(this.options.platform === "ios"
              ? {
                  onPending: async () => {
                    if (!confirmed) confirmed = await this.confirmIosLink();
                  },
                }
              : {}),
            rejectValues: ["idle"],
            rejectSubstrings: [" -> checking"],
          },
        );
        return;
      }
      const target = await this.findVisible(testID);
      this.options.signal.throwIfAborted();
      await target.tap();
      if (testID === "action-reload-app") this.activeScreenPath = undefined;
    });
  }

  async terminate(stage: string) {
    await this.runStage(stage, async () => {
      await this.options.client.postJson(stage, "/e2e/terminate-app", {});
      this.activeScreenPath = undefined;
    });
  }

  async typeText(stage: string, testID: string, text: string) {
    await this.runStage(stage, async () => {
      const resolved = String(this.resolve(text));
      const target = await this.findVisible(testID);
      this.options.signal.throwIfAborted();
      await target.fill(resolved);
      const field = inputFields[testID];
      if (field)
        await this.options.client.postJson(
          `${stage}: patch ${field}`,
          "/e2e/screen-state",
          { [field]: resolved },
        );
    });
  }

  async verifyConsoleInsights(sinceMs: number) {
    this.options.signal.throwIfAborted();
    if (this.pendingRecovery)
      throw new Error("Native recovery evidence is missing");
    const evidence = await this.options.client.postJson(
      "verify Console Insights",
      "/e2e/verify-console-insights",
      { sinceMs },
    );
    console.log(`[e2e-console-insights] ${JSON.stringify(evidence)}`);
    return evidence;
  }

  private async findVisible(
    testID: string,
    ensureForeground = true,
    alwaysOpen = false,
  ): Promise<Locator> {
    this.options.signal.throwIfAborted();
    if (this.pendingRecovery)
      throw new Error("Native recovery must be verified before UI interaction");
    const screenPath =
      (TEST_ID_SCREEN_PATHS as Record<string, string>)[testID] ?? "ready";
    let openedLink = false;
    if (ensureForeground) {
      if (this.options.platform === "android")
        await this.openApp({ relaunch: false });
      if (alwaysOpen || this.activeScreenPath !== screenPath) {
        this.options.signal.throwIfAborted();
        await this.options.device.openLink(
          (E2E_SCREEN_URLS as Record<string, string>)[screenPath],
          {
            app: this.options.appId,
          },
        );
        openedLink = true;
        this.activeScreenPath = screenPath;
      }
    }
    const target = this.options.screen.getByTestId(testID);
    // Mapped action routes execute on entry. Their control-plane result wait
    // observes progress without foregrounding an app that may be restarting.
    if (alwaysOpen) return target;
    const timeout =
      openedLink && this.options.platform === "ios"
        ? await this.waitForIosLink(target)
        : (this.options.assertionTimeoutMs ?? 30_000);
    this.options.signal.throwIfAborted();
    await target.waitFor({ state: "visible", timeout });
    return target;
  }

  private async confirmIosLink(): Promise<boolean> {
    this.options.signal.throwIfAborted();
    const alert = await this.options.iosAlert.get();
    this.options.signal.throwIfAborted();
    if (!alert) return false;
    // The native getter observes SpringBoard without activating the AUT.
    // Only these English/Korean app-open dialogs are supported; other prompts
    // stay visible and fail the scenario instead of granting a permission.
    const korean = /^[“‘"]HotUpdaterExample[”’"]에서 열겠습니까\?$/.test(
      alert.title,
    );
    const english =
      /^Open (?:this page )?in [“‘"]HotUpdaterExample[”’"]\?$/.test(
        alert.title,
      );
    const affirmative = korean ? "열기" : "Open";
    const negative = korean ? "취소" : "Cancel";
    if (
      (!korean && !english) ||
      alert.buttons.length !== 2 ||
      !alert.buttons.includes(affirmative) ||
      !alert.buttons.includes(negative)
    ) {
      throw new Error(
        `Unexpected iOS alert blocks the app link: ${alert.title}`,
      );
    }
    await this.options.screen
      .getByRole("alert", alert.title)
      .getByRole("button", affirmative)
      .tap();
    return true;
  }

  private async waitForIosLink(target: Locator): Promise<number> {
    const deadline = Date.now() + (this.options.assertionTimeoutMs ?? 30_000);
    const remaining = () => Math.max(1, deadline - Date.now());
    do {
      this.options.signal.throwIfAborted();
      if (await this.confirmIosLink()) return remaining();
      if (await target.isVisible()) return remaining();
      if (Date.now() >= deadline) break;
      await sleep(Math.min(100, remaining()), undefined, {
        signal: this.options.signal,
      });
    } while (Date.now() < deadline);
    return remaining();
  }

  private async openApp(options: OpenAppOptions) {
    this.options.signal.throwIfAborted();
    if (options.relaunch) this.activeScreenPath = undefined;
    await this.options.device.openApp(this.options.appId, {
      ...options,
      ...(options.relaunch
        ? { launchArguments: this.options.launchArguments }
        : {}),
    });
  }

  private resolve(value: unknown): unknown {
    if (typeof value === "string") {
      if (value.startsWith("$") && value.indexOf("$", 1) === -1)
        return this.value(value.slice(1));
      return value.replace(/\$([A-Za-z0-9_]+)/g, (_, key: string) =>
        String(this.value(key)),
      );
    }
    if (Array.isArray(value)) return value.map((item) => this.resolve(item));
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, this.resolve(item)]),
      );
    return value;
  }

  private value(key: string) {
    if (!Object.hasOwn(this.values, key))
      throw new Error(`Missing scenario value: ${key}`);
    return this.values[key];
  }

  private async runStage(stage: string, operation: () => Promise<void>) {
    this.options.signal.throwIfAborted();
    console.log(`[e2e-stage:start] ${stage}`);
    try {
      await operation();
      this.options.signal.throwIfAborted();
      console.log(`[e2e-stage:done] ${stage}`);
    } catch (error) {
      console.log(`[e2e-stage:failed] ${stage}`);
      throw error;
    }
  }
}
