export type E2eScreenState = {
  readonly channelActionResult: string;
  readonly cohortActionResult: string;
  readonly cohortInput: string | null;
  readonly runtimeChannelInput: string;
  readonly updateActionResult: string;
};

type E2eScreenStatePatch = Partial<E2eScreenState>;

const defaultE2eScreenState = {
  channelActionResult: "idle",
  cohortActionResult: "idle",
  cohortInput: null,
  runtimeChannelInput: "beta",
  updateActionResult: "idle",
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

  return {
    ...(channelActionResult === undefined ? {} : { channelActionResult }),
    ...(cohortActionResult === undefined ? {} : { cohortActionResult }),
    ...(cohortInput === undefined ? {} : { cohortInput }),
    ...(runtimeChannelInput === undefined ? {} : { runtimeChannelInput }),
    ...(updateActionResult === undefined ? {} : { updateActionResult }),
  };
};

export const readE2eScreenStateSnapshot = () => e2eScreenState;

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
