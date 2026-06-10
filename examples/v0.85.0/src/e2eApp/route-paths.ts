import { type LinkingOptions } from "@react-navigation/native";

import { e2eScreenPaths } from "./screen-paths";
import type { RootStackParamList, ScreenName } from "./types";

export { e2eScreenPaths, readyScreenPaths } from "./screen-paths";

export const e2eLinking: LinkingOptions<RootStackParamList> = {
  config: {
    screens: e2eScreenPaths,
  },
  prefixes: ["hotupdaterexample://"],
};

const e2eScreenNames = Object.keys(e2eScreenPaths) as ScreenName[];

export const screenNameFromE2eUrl = (url: string): ScreenName | undefined => {
  const path = url
    .replace(/^hotupdaterexample:\/\//, "")
    .replace(/^\/+/, "")
    .split(/[?#]/, 1)[0];

  return e2eScreenNames.find(
    (screenName) => e2eScreenPaths[screenName] === path,
  );
};
