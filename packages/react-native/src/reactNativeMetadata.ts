import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import { getMajor, getMinor, getPatch } from "verkit";

export interface ReactNativeMetadata {
  packagePath: string;
  versionRaw: string;
  version: {
    major: number;
    minor: number;
    patch?: number;
  };
}

export const getReactNativeMetadatas = (
  cwd = process.cwd(),
): ReactNativeMetadata => {
  try {
    const require = createRequire(import.meta.url);
    const packagePath = path.join(
      require.resolve("react-native", { paths: [cwd] }),
      "..",
    );
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(packagePath, "package.json"), "utf-8"),
    );
    const versionRaw: string = packageJson.version;
    return {
      packagePath,
      versionRaw,
      version: {
        major: getMajor(versionRaw),
        minor: getMinor(versionRaw),
        patch: getPatch(versionRaw),
      },
    };
  } catch (error) {
    console.warn(
      `Failed to parse react-native dependency path. Default values will be returned. This can cause a fatal issue in this process.\n${error}`,
    );
    return {
      packagePath: path.join(cwd, "node_modules", "react-native"),
      versionRaw: "0.0.0",
      version: { major: 0, minor: 0, patch: 0 },
    };
  }
};
