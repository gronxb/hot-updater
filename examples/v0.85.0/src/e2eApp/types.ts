export type RootStackParamList = {
  readonly Actions: undefined;
  readonly CohortActions: undefined;
  readonly Results: undefined;
  readonly Runtime: undefined;
};

export type ScreenName = keyof RootStackParamList;

export type ScreenNavigation = {
  readonly navigate: (screen: ScreenName) => void;
};
