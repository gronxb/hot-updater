export { HotUpdater, type HotUpdaterInstance } from "./client";
export { managedFontUrl, managedResourceUrl } from "./managedResource";
export { LynxUpdaterError } from "./native";
export { LYNX_RUNTIME_EVENT_LIMITS } from "./types";
export type {
  ActiveUpdateState,
  CheckForUpdateOptions,
  CheckForUpdateResult,
  ConfirmationResult,
  HotUpdaterInitOptions,
  HotUpdaterOptions,
  InstallResult,
  LaunchConfiguration,
  LaunchInfo,
  NotifyAppReadyResult,
  ResetChannelResult,
  ReleaseTransitionKind,
  RuntimeEvent,
  RuntimeEventsSnapshot,
  SelectionSummary,
  TransitionAcceptance,
} from "./types";

export { defineClientPlugin } from "@hot-updater/protocol";
export type {
  HotUpdaterBaseURL,
  ClientPluginApi,
  ClientPluginApis,
  HotUpdaterClientSetup,
  AppReadyResult,
  BundleDownloadedInfo,
  HotUpdaterClientContext,
  HotUpdaterClientHooks,
  HotUpdaterClientPlugin,
  HotUpdaterClientStorage,
  UpdateCheckResult,
  UpdateError,
  UpdateHttpResponse,
} from "@hot-updater/protocol";
