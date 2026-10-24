import fs from "fs/promises";
import path from "path";

import { getCwd } from "@hot-updater/cli-tools";

import {
  type AppVersionCandidate,
  type ResolvedAppVersion,
  resolveFromCandidates,
} from "./appVersionCandidates";

/** The native build scheme an Android version is read for. */
export interface AndroidAppVersionScope {
  /** The build variant, such as `stagingRelease`. */
  variant?: string;
  applicationId?: string;
  /** @default "app" */
  appModuleName?: string;
}

const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/** The body of the `{ ... }` block that opens at or after `from`. */
const readBlock = (source: string, from: number) => {
  const open = source.indexOf("{", from);
  if (open === -1) return null;

  let depth = 0;
  for (let index = open; index < source.length; index++) {
    if (source[index] === "{") depth++;
    if (source[index] === "}" && --depth === 0) {
      return { body: source.slice(open + 1, index), end: index + 1 };
    }
  }
  return null;
};

type NamedBlock = { name: string; body: string };

/** The top-level `name { ... }` blocks in a block body. */
const readNamedBlocks = (body: string) => {
  const blocks: NamedBlock[] = [];
  // Groovy `staging {`, Kotlin DSL `create("staging") {`.
  const header = /(?:create\(\s*["']([\w-]+)["']\s*\)|([\w-]+))\s*\{/g;

  let match: RegExpExecArray | null;
  while ((match = header.exec(body))) {
    const block = readBlock(body, match.index);
    if (!block) break;
    blocks.push({ name: match[1] ?? match[2]!, body: block.body });
    header.lastIndex = block.end;
  }
  return blocks;
};

/** The first block called `name`, in file order, at any depth. */
const findBlock = (source: string, name: string): NamedBlock | undefined =>
  readNamedBlocks(source)
    .flatMap((block) =>
      block.name === name ? [block] : [findBlock(block.body, name)],
    )
    .find((block) => block !== undefined);

/** A literal setting declared directly in a block body; null when not literal. */
const readSetting = (body: string, setting: string) => {
  const ownBody = readNamedBlocks(body).reduce(
    (rest, block) => rest.replace(block.body, ""),
    body,
  );
  const match = ownBody.match(
    new RegExp(`\\b${setting}\\b\\s*=?\\s*(?:(['"])([^'"]*)\\1|(\\S+))`),
  );
  if (!match) return undefined;
  return match[2] || null;
};

const capitalize = (value: string) =>
  value.charAt(0).toUpperCase() + value.slice(1);

/**
 * Whether a variant builds a flavor: `stagingRelease` builds `staging`, and
 * with flavor dimensions `brandAStagingRelease` builds `brandA` and `staging`.
 */
const variantBuildsFlavor = (variant: string, flavor: string) =>
  new RegExp(`${capitalize(flavor)}(?=[A-Z]|$)`).test(capitalize(variant));

/**
 * Reads versionName from defaultConfig and from each product flavor, so an
 * app whose flavors (brands, environments) override the version is reported
 * as ambiguous instead of resolving to the first versionName in the file.
 */
const getAndroidVersionFromAppBuildGradle = async (
  scope: AndroidAppVersionScope = {},
  baseVersion?: string,
): Promise<ResolvedAppVersion> => {
  const buildGradlePath = path.join(
    getCwd(),
    "android",
    scope.appModuleName ?? "app",
    "build.gradle",
  );

  let buildGradle: string;
  try {
    buildGradle = stripComments(await fs.readFile(buildGradlePath, "utf8"));
  } catch {
    return baseVersion === undefined
      ? { version: null, candidates: [] }
      : resolveFromCandidates([
          { label: "defaultConfig", version: baseVersion },
        ]);
  }

  const android = findBlock(buildGradle, "android")?.body ?? "";
  const defaultConfig = findBlock(android, "defaultConfig");
  const defaultVersion =
    baseVersion ??
    (defaultConfig
      ? readSetting(defaultConfig.body, "versionName")
      : undefined);

  const flavorsBlock = findBlock(android, "productFlavors");
  const flavors = (flavorsBlock ? readNamedBlocks(flavorsBlock.body) : []).map(
    (flavor) => ({
      name: flavor.name,
      applicationId: readSetting(flavor.body, "applicationId"),
      versionName: readSetting(flavor.body, "versionName"),
    }),
  );

  const defaultCandidate: AppVersionCandidate[] =
    defaultVersion === undefined
      ? []
      : [{ label: "defaultConfig", version: defaultVersion }];
  const flavorCandidates = (flavorList: typeof flavors) =>
    flavorList.flatMap((flavor): AppVersionCandidate[] =>
      flavor.versionName === undefined
        ? []
        : [{ label: `${flavor.name} flavor`, version: flavor.versionName }],
    );

  const { variant, applicationId } = scope;
  if (variant || applicationId) {
    const builtFlavors = flavors.filter(
      (flavor) =>
        (applicationId !== undefined &&
          flavor.applicationId === applicationId) ||
        (variant !== undefined && variantBuildsFlavor(variant, flavor.name)),
    );
    if (builtFlavors.length > 0) {
      // A flavor's versionName overrides defaultConfig's.
      const overrides = flavorCandidates(builtFlavors);
      return resolveFromCandidates(
        overrides.length > 0 ? overrides : defaultCandidate,
      );
    }
  }

  // Without a variant, every flavor that overrides the version is a
  // candidate, and so is defaultConfig unless every flavor overrides it.
  const overrides = flavorCandidates(flavors);
  const everyFlavorOverrides =
    flavors.length > 0 && overrides.length === flavors.length;
  return resolveFromCandidates([
    ...(everyFlavorOverrides ? [] : defaultCandidate),
    ...overrides,
  ]);
};

/**
 * `baseVersion` stands for defaultConfig's versionName, as a prebuild
 * writes it there; a product flavor's own versionName still overrides it.
 */
export const resolveAndroidAppVersion = (
  scope?: AndroidAppVersionScope,
  baseVersion?: string,
): Promise<ResolvedAppVersion> =>
  getAndroidVersionFromAppBuildGradle(scope, baseVersion);
