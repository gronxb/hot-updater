import type {
  NativeBuildIosScheme,
  RequiredDeep,
} from "@hot-updater/plugin-core";
import type { NativeBuildAndroidScheme } from "node_modules/@hot-updater/plugin-core/dist/index.cjs";

export const injectDefaultAndroidNativeBuildSchemeOptions = (
  scheme: NativeBuildAndroidScheme,
): RequiredDeep<NativeBuildAndroidScheme> => {
  return {
    aab: true,
    variant: "Release",
    appModuleName: "app",
    ...scheme,
  };
};

export const injectDefaultIosNativeBuildSchemeOptions = (
  scheme: NativeBuildIosScheme,
): RequiredDeep<NativeBuildIosScheme> => {
  return {
    buildConfiguration: "Release",
    ...scheme,
  } as any;
};
