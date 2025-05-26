import fs from "fs";
import { transform } from "oxc-transform";

export const transformEnv = <T extends Record<string, string>>(
  filename: string,
  env: T,
) => {
  const code = fs.readFileSync(filename, "utf-8");
  return transform(filename, code, {
    define: Object.fromEntries(
      Object.entries(env).map(([key, value]) => [
        `HotUpdater.${key}`,
        JSON.stringify(value),
      ]),
    ),
  }).code;
};
