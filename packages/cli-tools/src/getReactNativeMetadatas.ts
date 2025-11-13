import { createRequire } from "node:module";
import fs from "fs";
import path from "path";
import semverMajor from "semver/functions/major";
import semverMinor from "semver/functions/minor";
import semverPatch from "semver/functions/patch";
import { getCwd } from "./cwd";
import { p } from "./prompts";

export interface ReactNativeMetadata {
  packagePath: string;
  versionRaw: string;
  version: {
    major: number;
    minor: number;
    patch?: number;
  };
}
export const getReactNativeMetadatas = (cwd?: string): ReactNativeMetadata => {
  if (!cwd) cwd = getCwd();
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
    const major = semverMajor(versionRaw);
    const minor = semverMinor(versionRaw);
    const patch = semverPatch(versionRaw);

    return {
      packagePath,
      versionRaw,
      version: { major, minor, patch },
    };
  } catch (e) {
    p.log.warn(
      `Failed to parse react-native dependency path. Default values will be returned. This can cause fatal issue in this process.\n${e}`,
    );
    return {
      packagePath: path.join(cwd, "node_modules", "react-native"),
      versionRaw: "0.0.0",
      version: {
        major: 0,
        minor: 0,
        patch: 0,
      },
    };
  }
};
