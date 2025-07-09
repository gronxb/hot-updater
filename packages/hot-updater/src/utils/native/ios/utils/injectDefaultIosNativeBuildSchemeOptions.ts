import { NativeBuildIosScheme, RequiredDeep } from '@hot-updater/plugin-core';

export const injectDefaultIosNativeBuildSchemeOptions = (
  scheme: NativeBuildIosScheme,
): RequiredDeep<NativeBuildIosScheme> => {
  return {
    buildConfiguration: "Release",
    ...scheme,
  } as any;
};
