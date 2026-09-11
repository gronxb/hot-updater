import { checkForUpdate } from "./checkForUpdate";
import { callNative } from "./native";
import type {
  ConfirmationResult,
  HotUpdater,
  HotUpdaterOptions,
  NativeState,
  SelectionSummary,
} from "./types";

export { LynxUpdaterError } from "./native";
export type {
  ConfirmationResult,
  HotUpdater,
  HotUpdaterOptions,
  InstallResult,
  LaunchInfo,
  PreparedUpdate,
  SelectionSummary,
} from "./types";

const summary = (selection: SelectionSummary): SelectionSummary => ({
  kind: selection.kind,
  bundleId: selection.bundleId,
  releaseId: selection.releaseId,
  channel: selection.channel,
});

/** Creates an inert controller. Call its methods from Lynx background scripting. */
export function createHotUpdater(options: HotUpdaterOptions): HotUpdater {
  const config = {
    ...options,
    requestHeaders: options.requestHeaders
      ? { ...options.requestHeaders }
      : undefined,
  };
  return {
    async getLaunchInfo() {
      const state = await callNative<NativeState>("getState");
      return {
        platform: state.platform,
        runtimeId: state.runtimeId,
        running: summary(state.runningSelection),
        confirmed: state.runningConfirmed,
        next: state.nextSelection ? summary(state.nextSelection) : null,
      };
    },
    notifyAppReady: () => callNative<ConfirmationResult>("notifyAppReady"),
    checkForUpdate: () => checkForUpdate(config),
  };
}
