import { randomUUID } from "node:crypto";

export type E2eScreenState = {
  readonly channelActionResult: string;
  readonly cohortActionResult: string;
  readonly cohortInput: string | null;
  readonly runtimeChannelInput: string;
  readonly updateActionResult: string;
  readonly startupCheckEpoch: string;
  readonly startupCheckSettledEpoch: string;
  /** `<nonce>:<status>` the brownfield host posts after its native update check. */
  readonly nativeCheckResult: string;
  /** `<bundleId> <marker>` the brownfield widget runtime posts when it mounts. */
  readonly widgetState: string;
  /** What the widget runtime's update check did, as `widget -> ...`. */
  readonly widgetUpdateResult: string;
};

type E2eScreenStatePatch = Partial<E2eScreenState>;

const defaultE2eScreenState = {
  channelActionResult: "idle",
  cohortActionResult: "idle",
  cohortInput: null,
  runtimeChannelInput: "beta",
  updateActionResult: "idle",
  startupCheckEpoch: "",
  startupCheckSettledEpoch: "",
  nativeCheckResult: "",
  widgetState: "",
  widgetUpdateResult: "idle",
} as const satisfies E2eScreenState;

let e2eScreenState: E2eScreenState = defaultE2eScreenState;

const createScreenStateError = (message: string, details?: unknown) =>
  Object.assign(new Error(message), { details });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parseOptionalString = (
  payload: Record<string, unknown>,
  key: keyof E2eScreenState,
) => {
  if (!(key in payload)) return undefined;
  const value = payload[key];
  if (typeof value !== "string") {
    throw createScreenStateError("screen state field must be a string", {
      field: key,
      received: value,
    });
  }
  return value;
};

const parseOptionalCohortInput = (payload: Record<string, unknown>) => {
  if (!("cohortInput" in payload)) return undefined;
  const value = payload.cohortInput;
  if (value === null || typeof value === "string") return value;
  throw createScreenStateError("screen state field must be a string or null", {
    field: "cohortInput",
    received: value,
  });
};

const parseScreenStatePatch = (payload: unknown): E2eScreenStatePatch => {
  if (!isRecord(payload)) {
    throw createScreenStateError("screen state payload must be an object", {
      received: payload,
    });
  }

  const channelActionResult = parseOptionalString(
    payload,
    "channelActionResult",
  );
  const cohortActionResult = parseOptionalString(payload, "cohortActionResult");
  const runtimeChannelInput = parseOptionalString(
    payload,
    "runtimeChannelInput",
  );
  const updateActionResult = parseOptionalString(payload, "updateActionResult");
  const cohortInput = parseOptionalCohortInput(payload);
  const startupCheckSettledEpoch = parseOptionalString(
    payload,
    "startupCheckSettledEpoch",
  );
  const nativeCheckResult = parseOptionalString(payload, "nativeCheckResult");
  const widgetState = parseOptionalString(payload, "widgetState");
  const widgetUpdateResult = parseOptionalString(payload, "widgetUpdateResult");

  return {
    ...(channelActionResult === undefined ? {} : { channelActionResult }),
    ...(cohortActionResult === undefined ? {} : { cohortActionResult }),
    ...(cohortInput === undefined ? {} : { cohortInput }),
    ...(runtimeChannelInput === undefined ? {} : { runtimeChannelInput }),
    ...(updateActionResult === undefined ? {} : { updateActionResult }),
    ...(nativeCheckResult === undefined ? {} : { nativeCheckResult }),
    ...(widgetState === undefined ? {} : { widgetState }),
    ...(widgetUpdateResult === undefined ? {} : { widgetUpdateResult }),
    ...(startupCheckSettledEpoch &&
    startupCheckSettledEpoch === e2eScreenState.startupCheckEpoch
      ? { startupCheckSettledEpoch }
      : {}),
  };
};

export const readE2eScreenStateSnapshot = () => e2eScreenState;

export const prepareE2eStartupCheck = (alreadyFocused = false) => {
  if (!alreadyFocused) {
    // A new process posts its own widget values; the last process's must not
    // satisfy a wait for this launch's.
    e2eScreenState = {
      ...e2eScreenState,
      startupCheckEpoch: randomUUID(),
      startupCheckSettledEpoch: "",
      widgetState: defaultE2eScreenState.widgetState,
      widgetUpdateResult: defaultE2eScreenState.widgetUpdateResult,
    };
  }
  return { startupCheckEpoch: e2eScreenState.startupCheckEpoch };
};

export const resetE2eScreenState = () => {
  e2eScreenState = defaultE2eScreenState;
  return { screenState: readE2eScreenStateSnapshot() };
};

export const handlePatchE2eScreenState = (payload: unknown) => {
  e2eScreenState = {
    ...e2eScreenState,
    ...parseScreenStatePatch(payload),
  };
  return { screenState: readE2eScreenStateSnapshot() };
};
