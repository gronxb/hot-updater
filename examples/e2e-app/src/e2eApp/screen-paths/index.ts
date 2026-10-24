import { actionScreenPaths } from "./action-screen-paths";
import { inputScreenPaths } from "./input-screen-paths";
import { readyScreenPaths } from "./ready-screen-paths";
import { resultScreenPaths } from "./result-screen-paths";
import { runtimeScreenPaths } from "./runtime-screen-paths";
import { statusScreenPaths } from "./status-screen-paths";

export { readyScreenPaths } from "./ready-screen-paths";

export const e2eScreenPaths = {
  ...readyScreenPaths,
  ...runtimeScreenPaths,
  ...statusScreenPaths,
  ...resultScreenPaths,
  ...inputScreenPaths,
  ...actionScreenPaths,
} as const;
