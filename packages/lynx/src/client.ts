import {
  INVALID_COHORT_ERROR_MESSAGE,
  isValidCohort,
  normalizeCohortValue,
} from "@hot-updater/core";

import { checkForUpdate } from "./checkForUpdate";
import { callNative, LynxUpdaterError, normalizeNativeState } from "./native";
import { LYNX_RUNTIME_EVENT_LIMITS } from "./types";
import type {
  ActiveUpdateSelection,
  ActiveUpdateState,
  CheckForUpdateOptions,
  ConfirmationResult,
  CustomReloadHandler,
  HotUpdaterInitOptions,
  HotUpdaterOptions,
  LaunchInfo,
  LaunchConfiguration,
  LaunchTransitionReceipt,
  NativeState,
  NotifyAppReadyResult,
  ResetChannelResult,
  RuntimeEventsSnapshot,
  SelectionSummary,
  TransitionAcceptance,
} from "./types";

const missingInit = (methodName: string) =>
  new Error(
    `[HotUpdater] ${methodName} requires HotUpdater.init() to be used.\n\n` +
      `  HotUpdater.init({\n` +
      `    baseURL: "<your-update-server-url>",\n` +
      `  });\n`,
  );

const summary = (selection: SelectionSummary): SelectionSummary => ({
  kind: selection.kind,
  bundleId: selection.bundleId,
  releaseId: selection.releaseId,
  channel: selection.channel,
});

const publicSelection = (
  selection: NativeState["runningSelection"] | null,
): ActiveUpdateSelection | null =>
  selection === null
    ? null
    : {
        kind: selection.kind,
        releaseId: selection.releaseId,
        bundleId: selection.bundleId,
        channel: selection.channel,
      };

const isSelectionSummary = (value: unknown): value is SelectionSummary => {
  if (value === null || typeof value !== "object") return false;
  const selection = value as Partial<SelectionSummary>;
  return (
    (selection.kind === "BUNDLE" ||
      selection.kind === "EMBEDDED" ||
      selection.kind === "BUILTIN") &&
    typeof selection.bundleId === "string" &&
    selection.bundleId.length > 0 &&
    (selection.releaseId === null ||
      (typeof selection.releaseId === "string" &&
        selection.releaseId.length > 0)) &&
    typeof selection.channel === "string" &&
    selection.channel.length > 0
  );
};

const sameSelectionIdentity = (
  left: SelectionSummary,
  right: SelectionSummary,
) => left.bundleId === right.bundleId && left.releaseId === right.releaseId;

const sameSelection = (left: SelectionSummary, right: SelectionSummary) =>
  sameSelectionIdentity(left, right) &&
  left.kind === right.kind &&
  left.channel === right.channel;

const isTransitionAcceptance = (
  value: unknown,
): value is TransitionAcceptance =>
  value !== null &&
  typeof value === "object" &&
  (value as Partial<TransitionAcceptance>).status === "TRANSITION_ACCEPTED" &&
  typeof (value as Partial<TransitionAcceptance>).transitionId === "string" &&
  (value as Partial<TransitionAcceptance>).transitionId!.length > 0;

const hasExactKeys = (value: object, keys: readonly string[]) => {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const isSequence = (value: unknown): value is string =>
  typeof value === "string" && /^[1-9][0-9]*$/.test(value);

const incrementSequence = (value: string): string => {
  const digits = value.split("");
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    if (digits[index] !== "9") {
      digits[index] = String(Number(digits[index]) + 1);
      return digits.join("");
    }
    digits[index] = "0";
  }
  return `1${digits.join("")}`;
};

const utf8ByteLength = (value: string): number => {
  let bytes = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    bytes +=
      codePoint <= 0x7f
        ? 1
        : codePoint <= 0x7ff
          ? 2
          : codePoint <= 0xffff
            ? 3
            : 4;
  }
  return bytes;
};

const hasValidUnicode = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    }
  }
  return true;
};

const canonicalJson = (value: unknown, ancestors: Set<object>): string => {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Non-finite JSON number");
    return JSON.stringify(value);
  }
  if (typeof value === "string") {
    if (!hasValidUnicode(value)) throw new Error("Invalid JSON Unicode");
    return JSON.stringify(value);
  }
  if (typeof value !== "object") throw new Error("Non-JSON value");
  if (ancestors.has(value)) throw new Error("Cyclic JSON value");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const keys = Object.keys(value);
      if (
        keys.length !== value.length ||
        keys.some((key, index) => key !== String(index))
      ) {
        throw new Error("Sparse JSON array");
      }
      return `[${value.map((item) => canonicalJson(item, ancestors)).join(",")}]`;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error("Non-JSON object");
    }
    const entries = Object.keys(value).sort();
    return `{${entries
      .map((key) => {
        if (!hasValidUnicode(key)) throw new Error("Invalid JSON Unicode");
        return `${JSON.stringify(key)}:${canonicalJson(
          (value as Record<string, unknown>)[key],
          ancestors,
        )}`;
      })
      .join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
};

const canonicalJsonUtf8Bytes = (value: unknown): number | null => {
  try {
    return utf8ByteLength(canonicalJson(value, new Set()));
  } catch {
    return null;
  }
};

const hasOwn = (value: object, key: PropertyKey): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

const isCanonicalManagedPath = (value: unknown): value is string =>
  typeof value === "string" &&
  value.trim().length > 0 &&
  utf8ByteLength(value) <= LYNX_RUNTIME_EVENT_LIMITS.managedPathUtf8Bytes &&
  !value.startsWith("/") &&
  !value.endsWith("/") &&
  !/[\\%?#:]/.test(value) &&
  !Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0)!;
    return codePoint <= 0x1f || codePoint === 0x7f;
  }) &&
  value
    .split("/")
    .every((part) => part !== "" && part !== "." && part !== "..");

const isEngineDiagnosticDetails = (
  details: Record<string, unknown>,
): boolean => {
  for (const key of [
    "runtimeId",
    "processId",
    "generationId",
    "bundleId",
    "releaseId",
    "contextId",
    "attemptId",
    "pageAttemptId",
    "transitionId",
  ]) {
    if (!hasOwn(details, key)) return false;
  }
  return (
    [
      details.runtimeId,
      details.generationId,
      details.contextId,
      details.attemptId,
      details.bundleId,
    ].every((item) => typeof item === "string" && item.length > 0) &&
    typeof details.processId === "string" &&
    isSequence(details.processId) &&
    (details.releaseId === null ||
      (typeof details.releaseId === "string" &&
        details.releaseId.length > 0)) &&
    [details.pageAttemptId, details.transitionId].every(
      (item) => item === null || (typeof item === "string" && item.length > 0),
    ) &&
    typeof details.fatal === "boolean" &&
    Number.isSafeInteger(details.code) &&
    Number.isSafeInteger(details.subcode) &&
    typeof details.type === "string" &&
    details.type.length > 0 &&
    isCanonicalManagedPath(details.path)
  );
};

const validateRuntimeEvents = (value: unknown): RuntimeEventsSnapshot => {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "schemaVersion",
      "latestSequence",
      "oldestSequence",
      "truncated",
      "events",
    ]) ||
    value.schemaVersion !== 1 ||
    (value.latestSequence !== null && !isSequence(value.latestSequence)) ||
    (value.oldestSequence !== null && !isSequence(value.oldestSequence)) ||
    typeof value.truncated !== "boolean" ||
    !Array.isArray(value.events) ||
    value.events.length > LYNX_RUNTIME_EVENT_LIMITS.retainedEvents
  ) {
    throw new LynxUpdaterError(
      "INVALID_NATIVE_REPLY",
      "Native runtime events returned an invalid schema.",
    );
  }
  let previous: string | null = null;
  const events = value.events.map((item) => {
    if (
      !isRecord(item) ||
      !hasExactKeys(item, ["sequence", "name", "details"]) ||
      !isSequence(item.sequence) ||
      typeof item.name !== "string" ||
      item.name.length === 0 ||
      !hasValidUnicode(item.name) ||
      utf8ByteLength(item.name) > LYNX_RUNTIME_EVENT_LIMITS.nameUtf8Bytes ||
      !isRecord(item.details) ||
      (canonicalJsonUtf8Bytes(item.details) ?? Infinity) >
        LYNX_RUNTIME_EVENT_LIMITS.detailsUtf8Bytes ||
      (previous !== null && item.sequence !== incrementSequence(previous))
    ) {
      throw new LynxUpdaterError(
        "INVALID_NATIVE_REPLY",
        "Native runtime events returned an invalid event.",
      );
    }
    if (
      item.name === "engineDiagnostic" &&
      !isEngineDiagnosticDetails(item.details)
    ) {
      throw new LynxUpdaterError(
        "INVALID_NATIVE_REPLY",
        "Native runtime events returned an invalid engine diagnostic.",
      );
    }
    previous = item.sequence;
    return {
      sequence: item.sequence,
      name: item.name,
      details: { ...item.details },
    };
  });
  const oldestSequence = value.oldestSequence as string | null;
  const latestSequence = value.latestSequence as string | null;
  if (
    (events.length === 0 &&
      (oldestSequence !== null || latestSequence !== null)) ||
    (events.length > 0 &&
      (oldestSequence !== events[0]?.sequence ||
        latestSequence !== events.at(-1)?.sequence ||
        (!value.truncated && oldestSequence !== "1")))
  ) {
    throw new LynxUpdaterError(
      "INVALID_NATIVE_REPLY",
      "Native runtime event bounds do not match its events.",
    );
  }
  if (
    (canonicalJsonUtf8Bytes({
      events: value.events,
      nextSequence:
        latestSequence === null ? "1" : incrementSequence(latestSequence),
      schemaVersion: 1,
      truncated: value.truncated,
    }) ?? Infinity) > LYNX_RUNTIME_EVENT_LIMITS.journalUtf8Bytes
  ) {
    throw new LynxUpdaterError(
      "INVALID_NATIVE_REPLY",
      "Native runtime events exceed the journal bound.",
    );
  }
  return {
    schemaVersion: 1,
    latestSequence,
    oldestSequence,
    truncated: value.truncated,
    events,
  };
};

const isLaunchTransition = (
  value: unknown,
  running: SelectionSummary,
): value is LaunchTransitionReceipt => {
  if (value === null || typeof value !== "object") return false;
  const transition = value as Partial<LaunchTransitionReceipt>;
  if (
    (transition.kind !== "UPDATE_APPLIED" &&
      transition.kind !== "RECOVERED" &&
      transition.kind !== "UNCHANGED") ||
    !isSelectionSummary(transition.from) ||
    !isSelectionSummary(transition.to) ||
    !sameSelection(transition.to, running)
  ) {
    return false;
  }
  if (transition.kind === "UNCHANGED") {
    return (
      transition.from.bundleId === transition.to.bundleId &&
      typeof transition.from.releaseId === "string" &&
      typeof transition.to.releaseId === "string" &&
      transition.from.releaseId !== transition.to.releaseId
    );
  }
  if (transition.kind === "UPDATE_APPLIED") {
    return transition.from.bundleId !== transition.to.bundleId;
  }
  return !sameSelectionIdentity(transition.from, transition.to);
};

function createHotUpdaterClient() {
  const config: {
    client: HotUpdaterOptions | null;
    onError?: (error: Error) => void;
  } = {
    client: null,
  };
  let snapshot: NativeState | null = null;
  let customReload: CustomReloadHandler | null = null;

  const ensureClient = (methodName: string): HotUpdaterOptions => {
    if (!config.client) throw missingInit(methodName);
    return config.client;
  };

  const refreshState = async () => {
    const next = await callNative<NativeState>("getState");
    snapshot = normalizeNativeState(next);
    return snapshot;
  };

  const requireSnapshot = <T>(read: (state: NativeState) => T): T => {
    if (!snapshot) {
      throw new LynxUpdaterError(
        "NATIVE_STATE_UNAVAILABLE",
        "Call HotUpdater.notifyAppReady() or HotUpdater.checkForUpdate() before reading native state.",
      );
    }
    return read(snapshot);
  };

  return {
    async getLaunchConfiguration(): Promise<LaunchConfiguration> {
      const value = await callNative<LaunchConfiguration>(
        "getLaunchConfiguration",
      );
      if (
        value === null ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        Object.entries(value).some(
          ([key, item]) => key.length === 0 || typeof item !== "string",
        )
      ) {
        throw new LynxUpdaterError(
          "INVALID_NATIVE_REPLY",
          "Native launch configuration must be a string map.",
        );
      }
      return { ...value };
    },

    async getRuntimeEvents(): Promise<RuntimeEventsSnapshot> {
      return validateRuntimeEvents(
        await callNative<RuntimeEventsSnapshot>("getRuntimeEvents"),
      );
    },

    init: (options: HotUpdaterInitOptions): void => {
      config.onError = options.onError;
      config.client = {
        baseURL: options.baseURL,
        requestHeaders: options.requestHeaders
          ? { ...options.requestHeaders }
          : undefined,
        requestTimeout: options.requestTimeout,
      };
    },

    async checkForUpdate(options: CheckForUpdateOptions) {
      const client = ensureClient("checkForUpdate");
      try {
        const result = await checkForUpdate({
          ...options,
          client,
          requestHeaders: {
            ...client.requestHeaders,
            ...options.requestHeaders,
          },
          requestTimeout: options.requestTimeout ?? client.requestTimeout,
          onError: options.onError ?? config.onError,
        });
        await refreshState();
        if (!result) return null;
        return {
          ...result,
          updateBundle: async () => {
            const ok = await result.updateBundle();
            await refreshState();
            return ok;
          },
        };
      } catch (error) {
        (options.onError ?? config.onError)?.(error as Error);
        throw error;
      }
    },

    async notifyAppReady(): Promise<NotifyAppReadyResult> {
      await refreshState();
      const confirmation =
        await callNative<ConfirmationResult>("notifyAppReady");
      const after = await refreshState();
      const transition = confirmation?.transition;
      const transitionId = confirmation?.transitionId;
      if (
        (confirmation?.status !== "CONFIRMED" &&
          confirmation?.status !== "ALREADY_CONFIRMED") ||
        !("transition" in confirmation) ||
        !("transitionId" in confirmation) ||
        (transition === null
          ? transitionId !== null
          : typeof transitionId !== "string" || transitionId.length === 0) ||
        (transition !== null &&
          !isLaunchTransition(transition, after.runningSelection))
      ) {
        throw new LynxUpdaterError(
          "INVALID_NATIVE_REPLY",
          "Native readiness returned an invalid launch transition receipt.",
        );
      }
      if (transition === null) return { status: "UNCHANGED" };
      const acceptedTransitionId = transitionId as string;
      if (transition.kind === "UNCHANGED") {
        return {
          status: "UNCHANGED",
          transitionId: acceptedTransitionId,
          fromReleaseId: transition.from.releaseId!,
          toReleaseId: transition.to.releaseId!,
        };
      }
      return {
        status: transition.kind,
        transitionId: acceptedTransitionId,
        fromBundleId: transition.from.bundleId,
        toBundleId: transition.to.bundleId,
        ...(transition.from.releaseId === null
          ? {}
          : { fromReleaseId: transition.from.releaseId }),
        ...(transition.to.releaseId === null
          ? {}
          : { toReleaseId: transition.to.releaseId }),
      };
    },

    async getLaunchInfo(): Promise<LaunchInfo> {
      const state = await refreshState();
      return {
        platform: state.platform,
        runtimeId: state.runtimeId,
        running: summary(state.runningSelection),
        confirmed: state.runningConfirmed,
        next: state.nextSelection ? summary(state.nextSelection) : null,
      };
    },

    async reload() {
      if (customReload !== null) {
        await customReload();
        return;
      }
      const result = await callNative<TransitionAcceptance>("reload");
      if (!isTransitionAcceptance(result)) {
        throw new LynxUpdaterError(
          "INVALID_NATIVE_REPLY",
          "Native reload returned an invalid transition acceptance.",
        );
      }
      return result;
    },

    setReloadBehavior(behavior: "custom", handler: CustomReloadHandler) {
      if (behavior !== "custom" || typeof handler !== "function") {
        throw new LynxUpdaterError(
          "INVALID_CONFIG",
          'HotUpdater.setReloadBehavior("custom") requires a reload handler.',
        );
      }
      customReload = handler;
    },

    isUpdateDownloaded: () =>
      requireSnapshot((state) => state.nextSelection !== null),

    getAppVersion: () => requireSnapshot((state) => state.appVersion),
    getActiveUpdateState: (): ActiveUpdateState =>
      requireSnapshot((state) => ({
        activeSelection: publicSelection(
          state.nextSelection ?? state.runningSelection,
        ),
        stableSelection: publicSelection(state.confirmedSelection),
        verificationPending: !state.runningConfirmed,
      })),
    getBundleId: () =>
      requireSnapshot(
        (state) =>
          state.runningSelection.releaseId ?? state.runningSelection.bundleId,
      ),
    getMinBundleId: () => requireSnapshot((state) => state.minimumBundleId),
    getChannel: () => requireSnapshot((state) => state.channel),
    getDefaultChannel: () =>
      requireSnapshot((state) => state.defaultChannel ?? state.channel),
    isChannelSwitched: () =>
      requireSnapshot(
        (state) => state.channel !== (state.defaultChannel ?? state.channel),
      ),
    setCohort: (cohort: string) => {
      const normalized = normalizeCohortValue(cohort);
      if (!isValidCohort(normalized)) {
        throw new LynxUpdaterError(
          "INVALID_COHORT",
          INVALID_COHORT_ERROR_MESSAGE,
        );
      }
      return callNative<NativeState>("setCohort", {
        cohort: normalized,
      }).then((state) => {
        snapshot = normalizeNativeState(state);
      });
    },
    getCohort: () => requireSnapshot((state) => state.cohort),
    async updateBundle() {
      throw new LynxUpdaterError(
        "USE_CHECK_FOR_UPDATE",
        "Call checkForUpdate() and then update.updateBundle().",
      );
    },
    async resetChannel() {
      snapshot = null;
      try {
        const result = await callNative<ResetChannelResult>("resetChannel");
        if (result?.reset !== true || !isTransitionAcceptance(result)) {
          throw new LynxUpdaterError(
            "INVALID_NATIVE_REPLY",
            "Native channel reset returned an invalid transition acceptance.",
          );
        }
        return result;
      } finally {
        snapshot = null;
      }
    },
    getFingerprintHash: () =>
      requireSnapshot((state) => state.fingerprintHash ?? null),
    getCrashHistory: () =>
      requireSnapshot((state) => [...state.crashedBundleIds]),
    clearCrashHistory: async () => {
      await callNative("clearCrashHistory");
      await refreshState();
    },
  };
}

export const HotUpdater = createHotUpdaterClient();
