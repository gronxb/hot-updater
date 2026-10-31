import path from "path";

import { p } from "@hot-updater/cli-tools";

import {
  type AppStoreConnectApiKey,
  createAppStoreConnectRequest,
  findApp,
  readPrivateKey,
  retrying,
  sleep,
} from "./uploadToTestFlight";
import type { EnrichedNativeBuildIosScheme } from "./utils/enrichNativeBuildIosScheme";
import { readIpaInfo, readIpaInternalTestingOnly } from "./utils/readIpaInfo";
import { exportsForAppStoreConnect } from "./utils/xcodeSigning";

/** What a sandbox build must fit in App Store Connect. */
export interface AppStoreTrain {
  /**
   * The highest version Apple approved, such as `1.6.2`, or null with none.
   * Apple takes builds only of a version higher than this: anything else
   * fails after the whole upload, with 90186 and 90062.
   */
  readonly highestClosedVersion: string | null;
  /** The highest integer build number of the app's builds, or null. */
  readonly highestBuildNumber: number | null;
}

/**
 * The states of a version Apple hasn't approved, which still takes builds.
 * Any other state, such as one Apple adds later, counts as closed: a raise
 * costs a sandbox build nothing, and an upload to a closed train costs one.
 */
const OPEN_VERSION_STATES: ReadonlySet<string> = new Set([
  "PREPARE_FOR_SUBMISSION",
  "READY_FOR_REVIEW",
  "WAITING_FOR_REVIEW",
  "IN_REVIEW",
  "WAITING_FOR_EXPORT_COMPLIANCE",
  "PENDING_CONTRACT",
  "INVALID_BINARY",
  "METADATA_REJECTED",
  "REJECTED",
  "DEVELOPER_REJECTED",
]);

/** A version as numbers: `1.6.2`, or null for one that isn't only numbers. */
const parseVersion = (version: string): number[] | null =>
  /^\d+(\.\d+)*$/u.test(version) ? version.split(".").map(Number) : null;

/** Negative, zero or positive as `a` is below, equal to or above `b`. */
const compareVersions = (a: readonly number[], b: readonly number[]) => {
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const difference = (a[i] ?? 0) - (b[i] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
};

/** The highest of `versions`, ignoring any that aren't only numbers. */
const highestVersion = (versions: readonly string[]): string | null => {
  let highest: { text: string; parts: number[] } | null = null;
  for (const text of versions) {
    const parts = parseVersion(text);
    if (parts && (!highest || compareVersions(parts, highest.parts) > 0)) {
      highest = { text, parts };
    }
  }
  return highest?.text ?? null;
};

/** What an archive of a sandbox scheme takes from App Store Connect. */
export interface SandboxArchivePlan {
  /** Read before the build, or undefined when it can't reach the store. */
  readonly train?: AppStoreTrain;
  /** Which version an update targets: a closed train raises only under fingerprint. */
  readonly updateStrategy: "fingerprint" | "appVersion";
}

/** The highest integer build number among `versions`. */
const highestBuildNumberOf = (versions: readonly string[]): number | null => {
  const numbers = versions
    .filter((version) => /^\d+$/u.test(version))
    .map(Number);
  return numbers.length > 0 ? Math.max(...numbers) : null;
};

/**
 * Reads what a sandbox build must fit before it is built: the versions Apple
 * approved, from `/v1/appStoreVersions`, since a closed train's builds look
 * like any others in `/v1/builds`, and the app's highest build number.
 */
export const readAppStoreTrain = async ({
  bundleId,
  apiKey,
  fetch = globalThis.fetch,
}: {
  bundleId: string;
  apiKey: AppStoreConnectApiKey;
  fetch?: typeof globalThis.fetch;
}): Promise<AppStoreTrain> => {
  const privateKey = await readPrivateKey(apiKey.keyPath);
  const request = createAppStoreConnectRequest({ apiKey, privateKey, fetch });
  const { app } = await findApp(request, bundleId);
  const [{ data: versions }, { data: builds }] = await Promise.all([
    retrying(() =>
      request<{
        data: {
          attributes?: {
            versionString?: string;
            appVersionState?: string;
            appStoreState?: string;
          };
        }[];
      }>(
        "Reading the App Store versions",
        "GET",
        `/v1/apps/${app.id}/appStoreVersions?${new URLSearchParams({
          "filter[platform]": "IOS",
          "fields[appStoreVersions]":
            "versionString,appVersionState,appStoreState",
          limit: "200",
        })}`,
      ),
    ),
    retrying(() =>
      request<{ data: { attributes?: { version?: string } }[] }>(
        "Reading the app's builds",
        "GET",
        `/v1/builds?${new URLSearchParams({
          "filter[app]": app.id,
          sort: "-uploadedDate",
          "fields[builds]": "version",
          limit: "200",
        })}`,
      ),
    ),
  ]);
  const closed = versions.flatMap(({ attributes }) => {
    const state = attributes?.appVersionState ?? attributes?.appStoreState;
    return attributes?.versionString &&
      !(state && OPEN_VERSION_STATES.has(state))
      ? [attributes.versionString]
      : [];
  });
  return {
    highestClosedVersion: highestVersion(closed),
    highestBuildNumber: highestBuildNumberOf(
      builds.flatMap(({ attributes }) => attributes?.version ?? []),
    ),
  };
};

/**
 * What a sandbox device build needs from App Store Connect, read before the
 * build. An export for elsewhere has no train, and without an API key it
 * can't be read: the store would say so after the upload. What a closed train
 * does to the build waits for the archive (`patchSandboxArchive`): only the
 * archived app holds the version an `xcconfig` or `extraParams` settled on,
 * which the project's files don't.
 */
export const prepareSandboxArchive = async ({
  schemeConfig,
  apiKey,
  updateStrategy,
  fetch,
}: {
  schemeConfig: EnrichedNativeBuildIosScheme;
  apiKey?: AppStoreConnectApiKey;
  updateStrategy: "fingerprint" | "appVersion";
  fetch?: typeof globalThis.fetch;
}): Promise<SandboxArchivePlan> => {
  if (!(await exportsForAppStoreConnect(schemeConfig))) {
    return { updateStrategy };
  }
  if (!apiKey) {
    p.log.warn(
      "No App Store Connect API key, so the sandbox build can't check for a closed version.\nSet signing.ascApiKey on the scheme.",
    );
    return { updateStrategy };
  }
  const train = await readAppStoreTrain({
    bundleId: schemeConfig.bundleIdentifier,
    apiKey,
    ...(fetch ? { fetch } : {}),
  });
  return { train, updateStrategy };
};

/** Whether Apple refuses a build of `version`, as `train` says. */
export const isVersionTrainClosed = (
  version: string,
  { highestClosedVersion }: AppStoreTrain,
): boolean => {
  const parts = parseVersion(version);
  const closed =
    highestClosedVersion === null ? null : parseVersion(highestClosedVersion);
  return (
    parts !== null && closed !== null && compareVersions(parts, closed) <= 0
  );
};

/**
 * What a sandbox build does with a closed version train. Under the fingerprint
 * strategy it raises its own version past the closed one, which targets no
 * update. Under appVersion the version is what updates target, so it refuses
 * rather than move them silently.
 */
export const sandboxVersionDecision = ({
  version,
  train,
  updateStrategy,
}: {
  version: string;
  train: AppStoreTrain;
  updateStrategy: "fingerprint" | "appVersion";
}):
  | { readonly kind: "keep" }
  | { readonly kind: "raise"; readonly version: string }
  | { readonly kind: "refuse"; readonly message: string } => {
  if (!isVersionTrainClosed(version, train)) return { kind: "keep" };
  const closed = train.highestClosedVersion!;
  if (updateStrategy === "appVersion") {
    return {
      kind: "refuse",
      message: `App Store Connect closed version ${closed}, so TestFlight refuses ${version}.\nRaise the app version.`,
    };
  }
  const [major = 0, minor = 0, patch = 0] = parseVersion(closed)!;
  return { kind: "raise", version: `${major}.${minor}.${patch + 1}` };
};

/**
 * Refuses, before the upload, a sandbox `.ipa` Xcode didn't mark for internal
 * testing only: App Store Connect would let it reach App Store review.
 */
export const assertIpaIsInternalOnly = async (
  ipaPath: string,
): Promise<void> => {
  if (!(await readIpaInternalTestingOnly(ipaPath))) {
    throw new Error(
      `${path.basename(ipaPath)} isn't marked for internal testing only (TFInternalTestingOnly), so it wasn't uploaded.\nExport it with testFlightInternalTestingOnly.`,
    );
  }
};

/** How long App Store Connect may take to list a build it accepted. */
const AUDIENCE_TIMEOUT_MS = 5 * 60_000;

/**
 * Fails unless App Store Connect holds the uploaded sandbox build for internal
 * testing only, as `buildAudienceType` says once the build is listed.
 */
export const assertBuildIsInternalOnly = async ({
  ipaPath,
  apiKey,
  fetch = globalThis.fetch,
  pollIntervalMs = 5_000,
  timeoutMs = AUDIENCE_TIMEOUT_MS,
}: {
  ipaPath: string;
  apiKey: AppStoreConnectApiKey;
  fetch?: typeof globalThis.fetch;
  pollIntervalMs?: number;
  timeoutMs?: number;
}): Promise<void> => {
  const [info, privateKey] = await Promise.all([
    readIpaInfo(ipaPath),
    readPrivateKey(apiKey.keyPath),
  ]);
  const request = createAppStoreConnectRequest({ apiKey, privateKey, fetch });
  const { app, testFlightUrl } = await findApp(request, info.bundleId);
  const label = `${info.shortVersion} (${info.bundleVersion})`;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { data: builds } = await retrying(() =>
      request<{
        data: { attributes?: { buildAudienceType?: string | null } }[];
      }>(
        "Reading the build's audience",
        "GET",
        `/v1/builds?${new URLSearchParams({
          "filter[app]": app.id,
          "filter[version]": info.bundleVersion,
          "filter[preReleaseVersion.version]": info.shortVersion,
          "fields[builds]": "buildAudienceType",
          limit: "1",
        })}`,
      ),
    );
    const audience = builds[0]?.attributes?.buildAudienceType;
    if (audience === "INTERNAL_ONLY") return;
    if (audience) {
      throw new Error(
        `App Store Connect holds sandbox build ${label} for ${audience}, not INTERNAL_ONLY.\nExpire it in TestFlight:\n${testFlightUrl}`,
      );
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `App Store Connect didn't say who sandbox build ${label} is for.\nCheck that it is internal only in TestFlight:\n${testFlightUrl}`,
      );
    }
    await sleep(pollIntervalMs);
  }
};
