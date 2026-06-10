import type { RuntimeSnapshot } from "./runtime";

export type InstallUpdateInput = {
  readonly actionLabel: string;
  readonly channel?: string;
};

export type E2eRuntimeModel = {
  readonly applyCohortInput: () => Promise<void>;
  readonly channelActionResult: string;
  readonly clearCrashHistory: () => Promise<void>;
  readonly cohortActionResult: string;
  readonly cohortInput: string;
  readonly crashedBundleText: string;
  readonly initialCohort: string;
  readonly installRuntimeChannelUpdate: () => Promise<void>;
  readonly installUpdate: (input: InstallUpdateInput) => Promise<void>;
  readonly isUpdateDownloaded: boolean;
  readonly launchStatusText: string;
  readonly reloadApp: () => Promise<void>;
  readonly resetRuntimeChannel: () => Promise<void>;
  readonly restoreInitialCohort: () => Promise<void>;
  readonly runtimeChannelInput: string;
  readonly runtimeSnapshot: RuntimeSnapshot;
  readonly refreshRuntimeSnapshot: () => Promise<void>;
  readonly scenarioMarker: string;
  readonly setCohortToQa: () => Promise<void>;
  readonly setRuntimeChannelInput: (nextChannel: string) => void;
  readonly updateActionResult: string;
  readonly updateCohortInput: (nextCohort: string) => void;
  readonly updateStoreDownloadPathsText: string;
};
