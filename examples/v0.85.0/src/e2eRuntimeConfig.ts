import {
  HOT_UPDATER_APP_BASE_URL,
  HOT_UPDATER_E2E_RUNTIME_CONFIG_URL,
} from "@env";
import { LaunchArguments } from "react-native-launch-arguments";

const DEFAULT_APP_BASE_URL = "http://localhost:3007/hot-updater";
const DEFAULT_E2E_RUNTIME_CONFIG_URL =
  "http://localhost:3107/e2e/runtime-config";

export type E2eScreenState = {
  readonly channelActionResult: string;
  readonly cohortActionResult: string;
  readonly cohortInput: string | null;
  readonly runtimeChannelInput: string;
  readonly updateActionResult: string;
};

type E2ELaunchArguments = {
  readonly HOT_UPDATER_APP_BASE_URL?: unknown;
  readonly HOT_UPDATER_E2E_RUNTIME_CONFIG_URL?: unknown;
};

const defaultE2eScreenState = {
  channelActionResult: "idle",
  cohortActionResult: "idle",
  cohortInput: null,
  runtimeChannelInput: "beta",
  updateActionResult: "idle",
} as const satisfies E2eScreenState;

const e2eLaunchArguments = LaunchArguments.value<E2ELaunchArguments>();

const detoxLaunchArgumentString = (value: unknown) =>
  typeof value === "string" && value.trim() ? value.trim() : null;

export const fallbackHotUpdaterBaseURL =
  detoxLaunchArgumentString(e2eLaunchArguments.HOT_UPDATER_APP_BASE_URL) ??
  HOT_UPDATER_APP_BASE_URL ??
  DEFAULT_APP_BASE_URL;

const hotUpdaterRuntimeConfigURL =
  detoxLaunchArgumentString(
    e2eLaunchArguments.HOT_UPDATER_E2E_RUNTIME_CONFIG_URL,
  ) ??
  HOT_UPDATER_E2E_RUNTIME_CONFIG_URL ??
  DEFAULT_E2E_RUNTIME_CONFIG_URL;

const screenStateURLFromRuntimeConfigURL = (runtimeConfigURL: string) => {
  if (runtimeConfigURL.endsWith("/runtime-config")) {
    return runtimeConfigURL.replace(/\/runtime-config$/, "/screen-state");
  }

  return `${runtimeConfigURL.replace(/\/+$/, "")}/screen-state`;
};

const hotUpdaterScreenStateURL = screenStateURLFromRuntimeConfigURL(
  hotUpdaterRuntimeConfigURL,
);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const stringField = (
  payload: Record<string, unknown>,
  key: keyof E2eScreenState,
  fallback: string,
) => (typeof payload[key] === "string" ? payload[key] : fallback);

const parseScreenState = (payload: unknown): E2eScreenState => {
  if (!isRecord(payload)) return defaultE2eScreenState;

  const cohortInput = payload.cohortInput;

  return {
    channelActionResult: stringField(
      payload,
      "channelActionResult",
      defaultE2eScreenState.channelActionResult,
    ),
    cohortActionResult: stringField(
      payload,
      "cohortActionResult",
      defaultE2eScreenState.cohortActionResult,
    ),
    cohortInput:
      cohortInput === null || typeof cohortInput === "string"
        ? cohortInput
        : defaultE2eScreenState.cohortInput,
    runtimeChannelInput: stringField(
      payload,
      "runtimeChannelInput",
      defaultE2eScreenState.runtimeChannelInput,
    ),
    updateActionResult: stringField(
      payload,
      "updateActionResult",
      defaultE2eScreenState.updateActionResult,
    ),
  };
};

export const readE2eRuntimeConfig = async () => {
  const response = await fetch(hotUpdaterRuntimeConfigURL);
  if (!response.ok) {
    throw new Error(`runtime config returned HTTP ${response.status}`);
  }

  const payload: unknown = await response.json();
  const baseURL =
    payload &&
    typeof payload === "object" &&
    "baseURL" in payload &&
    typeof payload.baseURL === "string"
      ? payload.baseURL.trim()
      : null;
  const screenState =
    payload && typeof payload === "object" && "screenState" in payload
      ? parseScreenState(payload.screenState)
      : defaultE2eScreenState;

  return {
    baseURL: baseURL ? baseURL : null,
    screenState,
  };
};

export const readE2eScreenState = async () => {
  return (await readE2eRuntimeConfig()).screenState;
};

export const patchE2eScreenState = async (patch: Partial<E2eScreenState>) => {
  const response = await fetch(hotUpdaterScreenStateURL, {
    body: JSON.stringify(patch),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  if (!response.ok) {
    throw new Error(`screen state patch returned HTTP ${response.status}`);
  }
};

export const resolveHotUpdaterBaseURL = async () => {
  try {
    return (await readE2eRuntimeConfig()).baseURL ?? fallbackHotUpdaterBaseURL;
  } catch {
    return fallbackHotUpdaterBaseURL;
  }
};
