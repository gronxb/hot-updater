import type { e2eScreenPaths } from "./route-paths";

type RootStackScreenName = keyof typeof e2eScreenPaths;

export type RootStackParamList = {
  readonly [Screen in RootStackScreenName]: undefined;
};

export type ScreenName = RootStackScreenName;
