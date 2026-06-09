import type { ScreenNavigation } from "../types";
import type { E2eRuntimeModel } from "../useE2eRuntime";

export type ScreenProps = {
  readonly model: E2eRuntimeModel;
  readonly navigation: ScreenNavigation;
};
