export type RootStackParamList = {
  readonly ChannelActionResult: undefined;
  readonly CohortInputActions: undefined;
  readonly CohortPresetActions: undefined;
  readonly CohortActionResult: undefined;
  readonly CrashHistory: undefined;
  readonly InstallActions: undefined;
  readonly LaunchCrashedBundle: undefined;
  readonly LaunchStatus: undefined;
  readonly Ready: undefined;
  readonly RuntimeChannelActions: undefined;
  readonly RuntimeBundle: undefined;
  readonly RuntimeLargeAsset: undefined;
  readonly RuntimeMarker: undefined;
  readonly RuntimeState: undefined;
  readonly UpdateActionResult: undefined;
  readonly UpdateStore: undefined;
};

export type ScreenName = keyof RootStackParamList;
