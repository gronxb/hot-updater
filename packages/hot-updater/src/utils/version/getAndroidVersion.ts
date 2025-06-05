import path from "path";
import { getCwd } from "@hot-updater/plugin-core";
import fs from "fs/promises";
import semverValid from "semver/ranges/valid";

const getAndroidVersionFromAppBuildGradle = async (): Promise<
  string | null
> => {
  const buildGradlePath = path.join(getCwd(), "android", "app", "build.gradle");

  try {
    const buildGradleContent = await fs.readFile(buildGradlePath, "utf8");
    const versionNameMatch = buildGradleContent.match(
      /versionName\s+['"]([^"]+)['"]/,
    );
    return versionNameMatch?.[1] ?? null;
  } catch (error) {
    return null;
  }
};

const Strategy = {
  "app-build-gradle": getAndroidVersionFromAppBuildGradle,
};
type StrategyKey = keyof typeof Strategy;

export const getAndroidVersion = async ({
  strategy,
  validateWithSemver = false,
}: {
  strategy: StrategyKey | StrategyKey[];
  validateWithSemver?: boolean;
}): Promise<string | null> => {
  const strategies = Array.isArray(strategy) ? strategy : [strategy];

  for (const strategy of strategies) {
    const parsedVersion = await Strategy[strategy]();

    if (!parsedVersion) continue;
    if (validateWithSemver && !semverValid(parsedVersion)) continue;

    return parsedVersion;
  }

  return null;
};
