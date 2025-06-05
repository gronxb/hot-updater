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

const AndroidVersionParsers = {
  "app-build-gradle": getAndroidVersionFromAppBuildGradle,
};
type AndroidVersionParser = keyof typeof AndroidVersionParsers;

export const getAndroidVersion = async ({
  parser,
  validateWithSemver = false,
}: {
  parser: AndroidVersionParser | AndroidVersionParser[];
  validateWithSemver?: boolean;
}): Promise<string | null> => {
  const parsers = Array.isArray(parser) ? parser : [parser];

  for (const parserKey of parsers) {
    const parsedVersion = await AndroidVersionParsers[parserKey]();

    if (!parsedVersion) continue;
    if (validateWithSemver && !semverValid(parsedVersion)) continue;

    return parsedVersion;
  }

  return null;
};
