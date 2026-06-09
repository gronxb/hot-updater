import {
  ApplyCohortInputActionScreen,
  ClearCrashHistoryActionScreen,
  CohortInputScreen,
  InstallCurrentChannelUpdateActionScreen,
  InstallRuntimeChannelUpdateActionScreen,
  RefreshRuntimeSnapshotActionScreen,
  ReloadAppActionScreen,
  ResetRuntimeChannelActionScreen,
  RestoreInitialCohortActionScreen,
  RuntimeChannelInputScreen,
  SetCohortQaActionScreen,
} from "../screens";
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
