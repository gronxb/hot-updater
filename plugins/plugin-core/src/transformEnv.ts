import { transform } from "oxc-transform";

export const transformEnv = <T extends Record<string, string>>(
  code: string,
  env: T,
) => {
  return transform("", code, {
    define: Object.fromEntries(
      Object.entries(env).map(([key, value]) => [
        `HotUpdater.${key}`,
        JSON.stringify(value),
      ]),
    ),
  }).code;
};
