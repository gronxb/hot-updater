import type { Device, OpenAppOptions } from "@e2e-dev/mobile";
import { expect } from "e2e";
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
import type { IosAlert } from "./ios-alert.ts";

const inputFields: Record<string, string> = {
  "cohort-input": "cohortInput",
  "runtime-channel-input": "runtimeChannelInput",
};
const actionFields: Record<string, string> = {
  "action-activate-remote-config": "updateActionResult",
  "action-apply-captured-update": "updateActionResult",
  "action-apply-cohort-input": "cohortActionResult",
  "action-capture-current-channel-update": "updateActionResult",
  "action-fetch-and-activate-remote-config": "updateActionResult",
  "action-fetch-remote-config": "updateActionResult",
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

// An action route has started once its result leaves idle; the control
// client's own screen-state wait then allows a minute for the result.
const ROUTE_START_TIMEOUT_MS = 60_000;

// Scenarios list alternatives a result may contain; any one satisfies them.
// Each is normalized the way the SDK normalizes the text it is matched against.
function containsAnyOf(texts: readonly string[]): string | RegExp {
  const normalized = texts.map((text) => text.replace(/\s+/gu, " ").trim());
  if (normalized.length === 0)
    throw new Error("A text assertion needs at least one expected value");
  if (normalized.length === 1) return normalized[0]!;
  return new RegExp(
    normalized
      .map((text) => text.replace(/[$()*+.?[\\\]^{|}]/g, "\\$&"))
      .join("|"),
  );
}

// The runner cancels an attempt's SDK steps with this code on a timeout or an
// interrupt; such a step says nothing about the app.
function isCancelledStep(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "CANCELLED"
  );
}

type DriverOptions = {
  readonly client: Pick<
    ControlClient,
    "postJson" | "readScreenStateField" | "runJob" | "waitForScreenStateField"
  >;
  readonly device: Pick<Device, "openApp" | "openLink">;
  readonly screen: Pick<Screen, "getByTestId" | "getByRole">;
  readonly iosAlert: { get(): Promise<IosAlert | null> };
  readonly appId: string;
  readonly platform: "ios" | "android";
  readonly signal: AbortSignal;
  readonly initialValues?: JsonObject;
};

export class MobileAppDriver implements ScenarioAppDriver {
  private readonly options: DriverOptions;
  private readonly values: JsonObject;
  private activeScreenPath?: string;
  private pendingRecovery?: "crash" | "reload";
  private pendingLaunchFailure = false;
  private verifiedLaunchFailures = 0;

  get expectedLaunchFailures() {
    return this.verifiedLaunchFailures;
  }

  constructor(options: DriverOptions) {
    this.options = options;
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
      const target = await this.openScreen(testID, options.ensureForeground);
      this.options.signal.throwIfAborted();
      // The matcher waits up to config.assertionTimeout for one visible node
      // with the text, so no separate visibility check runs first.
      await (options.exactText
        ? expect(target).toHaveText(expected[0]!)
        : expect(target).toContainText(containsAnyOf(expected)));
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
        if (!recovering || isCancelledStep(error)) throw error;
        this.pendingLaunchFailure = true;
        // The next control assertions must establish recovery; no UI action is
        // permitted to hide this disconnect by opening the app again.
        console.log(`[e2e-launch:awaiting-recovery] ${String(error)}`);
      }
      if (!recovering) await this.waitForStartupCheck(stage, launchState);
    });
  }

  async reload(stage: string) {
    await this.runStage(stage, async () => {
      await this.options.client.postJson(
        `${stage}: terminate app`,
        "/e2e/terminate-app",
        {},
      );
      const launchState = await this.options.client.postJson(
        `${stage}: prepare launch`,
        "/e2e/prepare-app-launch",
        {},
      );
      await this.openApp({ relaunch: true });
      await this.waitForStartupCheck(stage, launchState);
    });
  }

  async resetAppState(stage: string) {
    await this.runStage(stage, async () => {
      await this.options.client.postJson(
        `${stage}: reset local app state`,
        "/e2e/reset-local-app-state",
        {},
      );
      const launchState = await this.options.client.postJson(
        `${stage}: prepare launch`,
        "/e2e/prepare-app-launch",
        {},
      );
      await this.openApp({ relaunch: true });
      await this.waitForStartupCheck(stage, launchState);
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
        await this.openScreen(testID, true, true);
        if (this.options.platform === "ios") {
          await this.acceptAppLinkUntil(async () => {
            const value = await this.options.client.readScreenStateField(field);
            return value !== undefined && value !== "idle";
          }, ROUTE_START_TIMEOUT_MS);
        }
        await this.options.client.waitForScreenStateField(
          `${stage}: wait ${field}`,
          field,
          { rejectValues: ["idle"], rejectSubstrings: [" -> checking"] },
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

  private async findVisible(testID: string): Promise<Locator> {
    const target = await this.openScreen(testID);
    this.options.signal.throwIfAborted();
    await expect(target).toBeVisible();
    return target;
  }

  // Brings the screen that shows testID forward and returns a locator for its
  // visible node, without waiting for it.
  private async openScreen(
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
      const opensRoute = alwaysOpen || this.activeScreenPath !== screenPath;
      // An app-bound Android link already brings the selected app forward.
      if (this.options.platform === "android" && !opensRoute)
        await this.openApp({ relaunch: false });
      if (opensRoute) {
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
    const target = this.options.screen.getByTestId(testID, { visible: true });
    // Mapped action routes execute on entry. Their control-plane result wait
    // observes progress without foregrounding an app that may be restarting.
    if (alwaysOpen) return target;
    if (openedLink && this.options.platform === "ios")
      await this.acceptAppLinkUntil(() => target.isVisible());
    return target;
  }

  // iOS may ask to open a route in the app first. The poll only reads
  // (whether the route got through, else the system alert) so no step fails
  // and recovers inside it. A read that throws ends the poll and is rethrown
  // as is; the expected dialog is accepted once, after the poll, and any
  // other alert fails at once.
  private async acceptAppLinkUntil(
    routed: () => Promise<boolean>,
    timeout?: number,
  ) {
    let outcome = null as { alert?: IosAlert; error?: unknown } | null;
    await expect
      .poll(
        async () => {
          try {
            this.options.signal.throwIfAborted();
            if (await routed()) outcome = {};
            else {
              const alert = await this.options.iosAlert.get();
              if (alert) outcome = { alert };
            }
          } catch (error) {
            outcome = { error };
          }
          return outcome !== null;
        },
        {
          ...(timeout === undefined ? {} : { timeout }),
          message: "the iOS route neither opened nor asked to open the app",
        },
      )
      .toBe(true);
    this.options.signal.throwIfAborted();
    if (outcome?.error !== undefined) throw outcome.error;
    if (outcome?.alert) await this.acceptAppLinkAlert(outcome.alert);
  }

  private async acceptAppLinkAlert(alert: IosAlert) {
    // The native getter observes SpringBoard without activating the AUT.
    // Only these English/Korean app-open dialogs are supported; other prompts
    // stay visible and fail the scenario instead of granting a permission.
    const koreanTitle = /^[“‘"]HotUpdaterExample[”’"]에서 열겠습니까\?$/;
    // agent-device0.21.22's preferredAlertTitle filters scroll-bar labels in
    // English only. Its Korean descendant label is not the alert's root name;
    // prove the expected app against the exact root locator before tapping.
    const reportedScrollBar = alert.title === "수직 스크롤 막대, 1페이지";
    const korean = koreanTitle.test(alert.title) || reportedScrollBar;
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
      .getByRole("alert", reportedScrollBar ? koreanTitle : alert.title)
      .getByRole("button", affirmative)
      .tap();
  }

  private async waitForStartupCheck(stage: string, launchState: JsonObject) {
    const epoch = launchState.startupCheckEpoch;
    if (typeof epoch !== "string" || !epoch) {
      throw new Error(
        "Prepare app launch did not return a startup check epoch",
      );
    }
    await this.options.client.waitForScreenStateField(
      `${stage}: wait startup check`,
      "startupCheckSettledEpoch",
      { expectedValue: epoch },
    );
  }

  private async openApp(options: OpenAppOptions) {
    this.options.signal.throwIfAborted();
    if (options.relaunch) this.activeScreenPath = undefined;
    // A relaunch of the pinned app carries the target's launchArguments.
    await this.options.device.openApp(this.options.appId, options);
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
