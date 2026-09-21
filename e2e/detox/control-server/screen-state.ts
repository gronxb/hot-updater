export type E2eScreenState = {
  readonly channelActionResult: string;
  readonly cohortActionResult: string;
  readonly cohortInput: string | null;
  readonly currentChannel: string | null;
  readonly currentBundleId: string | null;
  readonly currentReleaseId: string | null;
  readonly currentCohort: string | null;
  readonly crashHistoryCount: string | null;
  readonly defaultChannel: string | null;
  readonly detailPageMarker: string | null;
  readonly detailPageTitle: string | null;
  readonly diagnosticReceipt: string | null;
  readonly generationEvents: string | null;
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
  currentBundleId: null,
  currentReleaseId: null,
  currentCohort: null,
  crashHistoryCount: null,
  defaultChannel: null,
  detailPageMarker: null,
  detailPageTitle: null,
  diagnosticReceipt: null,
  generationEvents: null,
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
let e2eScreenStateLaunchGeneration: string | null = null;
let e2eScreenStateRuntimeGenerationEpoch: string | null = null;

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
  const currentBundleId = parseOptionalNullableString(
    payload,
    "currentBundleId",
  );
  const currentReleaseId = parseOptionalNullableString(
    payload,
    "currentReleaseId",
  );
  const currentCohort = parseOptionalNullableString(payload, "currentCohort");
  const crashHistoryCount = parseOptionalNullableString(
    payload,
    "crashHistoryCount",
  );
  const defaultChannel = parseOptionalNullableString(payload, "defaultChannel");
  const detailPageMarker = parseOptionalNullableString(
    payload,
    "detailPageMarker",
  );
  const detailPageTitle = parseOptionalNullableString(
    payload,
    "detailPageTitle",
  );
  const generationEvents = parseOptionalNullableString(
    payload,
    "generationEvents",
  );
  const diagnosticReceipt = parseOptionalNullableString(
    payload,
    "diagnosticReceipt",
  );
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
    ...(currentBundleId === undefined ? {} : { currentBundleId }),
    ...(currentReleaseId === undefined ? {} : { currentReleaseId }),
    ...(currentCohort === undefined ? {} : { currentCohort }),
    ...(crashHistoryCount === undefined ? {} : { crashHistoryCount }),
    ...(defaultChannel === undefined ? {} : { defaultChannel }),
    ...(detailPageMarker === undefined ? {} : { detailPageMarker }),
    ...(detailPageTitle === undefined ? {} : { detailPageTitle }),
    ...(diagnosticReceipt === undefined ? {} : { diagnosticReceipt }),
    ...(generationEvents === undefined ? {} : { generationEvents }),
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
  e2eScreenStateLaunchGeneration = null;
  e2eScreenStateRuntimeGenerationEpoch = null;
  return { screenState: readE2eScreenStateSnapshot() };
};

export const beginE2eScreenStateLaunch = (launchGeneration: string | null) => {
  const result = resetE2eScreenState();
  e2eScreenStateLaunchGeneration = launchGeneration;
  return result;
};

export const setE2eScreenStateLaunchGeneration = (
  launchGeneration: string | null,
) => {
  e2eScreenStateLaunchGeneration = launchGeneration;
};

const canonicalEpoch = (value: unknown): string | null =>
  typeof value === "string" && /^[1-9][0-9]*$/.test(value) ? value : null;

export const handlePatchE2eScreenState = (payload: unknown) => {
  const recordPayload = isRecord(payload) ? payload : null;
  const publishesRuntimeMarker =
    recordPayload !== null &&
    typeof recordPayload.runtimeScenarioMarker === "string";
  const incomingEpoch = canonicalEpoch(recordPayload?.runtimeGenerationEpoch);
  if (
    publishesRuntimeMarker &&
    e2eScreenStateLaunchGeneration !== null &&
    recordPayload?.launchGeneration !== e2eScreenStateLaunchGeneration
  ) {
    throw createScreenStateError("stale screen state launch generation", {
      expected: e2eScreenStateLaunchGeneration,
      received: recordPayload?.launchGeneration,
    });
  }
  if (publishesRuntimeMarker && incomingEpoch !== null) {
    if (
      e2eScreenStateRuntimeGenerationEpoch !== null &&
      BigInt(incomingEpoch) < BigInt(e2eScreenStateRuntimeGenerationEpoch)
    ) {
      throw createScreenStateError("stale screen state runtime generation", {
        expected: e2eScreenStateRuntimeGenerationEpoch,
        received: incomingEpoch,
      });
    }
    e2eScreenStateRuntimeGenerationEpoch = incomingEpoch;
  }
  e2eScreenState = {
    ...e2eScreenState,
    ...parseScreenStatePatch(payload),
  };
  return {
    launchGeneration: e2eScreenStateLaunchGeneration,
    runtimeGenerationEpoch: e2eScreenStateRuntimeGenerationEpoch,
    screenState: readE2eScreenStateSnapshot(),
  };
};
