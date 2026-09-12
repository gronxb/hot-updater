export type E2eScreenState = {
  readonly channelActionResult: string;
  readonly cohortActionResult: string;
  readonly cohortInput: string | null;
  readonly currentChannel: string | null;
  readonly defaultChannel: string | null;
  readonly channelSwitched: string | null;
  readonly launchStatus: string;
  readonly runtimeChannelInput: string;
  readonly runtimeScenarioMarker: string | null;
  readonly stagingBundleId: string | null;
  readonly stagingReleaseId: string | null;
  readonly stableBundleId: string | null;
  readonly stableReleaseId: string | null;
  readonly updateActionResult: string;
  readonly verificationPending: boolean | null;
};

type E2eScreenStatePatch = Partial<E2eScreenState>;

const defaultE2eScreenState = {
  channelActionResult: "idle",
  cohortActionResult: "idle",
  cohortInput: null,
  currentChannel: null,
  defaultChannel: null,
  channelSwitched: null,
  launchStatus: "Current Launch Status: null",
  runtimeChannelInput: "beta",
  runtimeScenarioMarker: null,
  stagingBundleId: null,
  stagingReleaseId: null,
  stableBundleId: null,
  stableReleaseId: null,
  updateActionResult: "idle",
  verificationPending: null,
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

const parseOptionalNullableString = (
  payload: Record<string, unknown>,
  key: keyof E2eScreenState,
) => {
  if (!(key in payload)) return undefined;
  const value = payload[key];
  if (value === null || typeof value === "string") return value;
  throw createScreenStateError("screen state field must be a string or null", {
    field: key,
    received: value,
  });
};

const parseOptionalNullableBoolean = (
  payload: Record<string, unknown>,
  key: keyof E2eScreenState,
) => {
  if (!(key in payload)) return undefined;
  const value = payload[key];
  if (value === null || typeof value === "boolean") return value;
  throw createScreenStateError("screen state field must be a boolean or null", {
    field: key,
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
  const launchStatus = parseOptionalString(payload, "launchStatus");
  const updateActionResult = parseOptionalString(payload, "updateActionResult");
  const cohortInput = parseOptionalCohortInput(payload);
  const currentChannel = parseOptionalNullableString(payload, "currentChannel");
  const defaultChannel = parseOptionalNullableString(payload, "defaultChannel");
  const channelSwitched = parseOptionalNullableString(
    payload,
    "channelSwitched",
  );
  const runtimeScenarioMarker = parseOptionalNullableString(
    payload,
    "runtimeScenarioMarker",
  );
  const stagingBundleId = parseOptionalNullableString(
    payload,
    "stagingBundleId",
  );
  const stagingReleaseId = parseOptionalNullableString(
    payload,
    "stagingReleaseId",
  );
  const stableBundleId = parseOptionalNullableString(payload, "stableBundleId");
  const stableReleaseId = parseOptionalNullableString(
    payload,
    "stableReleaseId",
  );
  const verificationPending = parseOptionalNullableBoolean(
    payload,
    "verificationPending",
  );

  return {
    ...(channelActionResult === undefined ? {} : { channelActionResult }),
    ...(cohortActionResult === undefined ? {} : { cohortActionResult }),
    ...(cohortInput === undefined ? {} : { cohortInput }),
    ...(currentChannel === undefined ? {} : { currentChannel }),
    ...(defaultChannel === undefined ? {} : { defaultChannel }),
    ...(channelSwitched === undefined ? {} : { channelSwitched }),
    ...(launchStatus === undefined ? {} : { launchStatus }),
    ...(runtimeChannelInput === undefined ? {} : { runtimeChannelInput }),
    ...(runtimeScenarioMarker === undefined ? {} : { runtimeScenarioMarker }),
    ...(stagingBundleId === undefined ? {} : { stagingBundleId }),
    ...(stagingReleaseId === undefined ? {} : { stagingReleaseId }),
    ...(stableBundleId === undefined ? {} : { stableBundleId }),
    ...(stableReleaseId === undefined ? {} : { stableReleaseId }),
    ...(updateActionResult === undefined ? {} : { updateActionResult }),
    ...(verificationPending === undefined ? {} : { verificationPending }),
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
