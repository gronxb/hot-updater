import { ApplyCohortInputActionScreen } from "../screens/apply-cohort-input-action-screen";
import { ClearCrashHistoryActionScreen } from "../screens/clear-crash-history-action-screen";
import { CohortInputScreen } from "../screens/cohort-input-screen";
import { InstallCurrentChannelUpdateActionScreen } from "../screens/install-current-channel-update-action-screen";
import { InstallRuntimeChannelUpdateActionScreen } from "../screens/install-runtime-channel-update-action-screen";
import { RefreshRuntimeSnapshotActionScreen } from "../screens/refresh-runtime-snapshot-action-screen";
import { ReloadAppActionScreen } from "../screens/reload-app-action-screen";
import { ResetRuntimeChannelActionScreen } from "../screens/reset-runtime-channel-action-screen";
import { RestoreInitialCohortActionScreen } from "../screens/restore-initial-cohort-action-screen";
import { RuntimeChannelInputScreen } from "../screens/runtime-channel-input-screen";
import { SetCohortQaActionScreen } from "../screens/set-cohort-qa-action-screen";
import { defineModelScreens } from "./types";

export const interactionModelScreens = defineModelScreens([
  ["RefreshRuntimeSnapshotAction", RefreshRuntimeSnapshotActionScreen],
  ["ReloadAppAction", ReloadAppActionScreen],
  ["ClearCrashHistoryAction", ClearCrashHistoryActionScreen],
  [
    "InstallCurrentChannelUpdateAction",
    InstallCurrentChannelUpdateActionScreen,
  ],
  ["RuntimeChannelInput", RuntimeChannelInputScreen],
  [
    "InstallRuntimeChannelUpdateAction",
    InstallRuntimeChannelUpdateActionScreen,
  ],
  ["ResetRuntimeChannelAction", ResetRuntimeChannelActionScreen],
  ["CohortInput", CohortInputScreen],
  ["ApplyCohortInputAction", ApplyCohortInputActionScreen],
  ["SetCohortQaAction", SetCohortQaActionScreen],
  ["RestoreInitialCohortAction", RestoreInitialCohortActionScreen],
]);
