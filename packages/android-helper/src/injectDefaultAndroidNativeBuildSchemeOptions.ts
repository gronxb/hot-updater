import { NativeBuildAndroidScheme, RequiredDeep } from '@hot-updater/plugin-core';

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
