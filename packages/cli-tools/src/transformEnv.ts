import fs from "fs";

import { transformSync } from "oxc-transform";

export const transformEnv = <T extends Record<string, string>>(
  filename: string,
  env: T,
) => {
  const code = fs.readFileSync(filename, "utf-8");
  return (
    transformSync(filename, code, {
      define: Object.fromEntries(
        Object.entries(env).map(([key, value]) => [
          `HotUpdater.${key}`,
          JSON.stringify(value),
        ]),
      ),
    })?.code || code
  );
};
