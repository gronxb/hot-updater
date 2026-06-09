export type RootStackParamList = {
  readonly ActionResults: undefined;
  readonly CohortInputActions: undefined;
  readonly CohortPresetActions: undefined;
  readonly CrashHistory: undefined;
  readonly InstallActions: undefined;
  readonly LaunchStatus: undefined;
  readonly RuntimeChannelActions: undefined;
  readonly RuntimeIdentity: undefined;
  readonly RuntimeState: undefined;
  readonly UpdateStore: undefined;
};

export type ScreenName = keyof RootStackParamList;

export type ScreenNavigation = {
  readonly navigate: (screen: ScreenName) => void;
};
