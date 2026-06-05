import {
  HOT_UPDATER_APP_BASE_URL,
  HOT_UPDATER_E2E_RUNTIME_CONFIG_URL,
} from "@env";
import { LaunchArguments } from "react-native-launch-arguments";

const DEFAULT_APP_BASE_URL = "http://localhost:3007/hot-updater";
const DEFAULT_E2E_RUNTIME_CONFIG_URL =
  "http://localhost:3107/e2e/runtime-config";

type E2ELaunchArguments = {
  readonly HOT_UPDATER_APP_BASE_URL?: unknown;
  readonly HOT_UPDATER_E2E_RUNTIME_CONFIG_URL?: unknown;
};

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

const fetchRuntimeConfigBaseURL = async () => {
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

  return baseURL ? baseURL : null;
};

export const resolveHotUpdaterBaseURL = async () => {
  try {
    return (await fetchRuntimeConfigBaseURL()) ?? fallbackHotUpdaterBaseURL;
  } catch {
    return fallbackHotUpdaterBaseURL;
  }
};
