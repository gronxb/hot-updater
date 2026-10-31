import path from "path";

import { p } from "@hot-updater/cli-tools";

import {
  type AppStoreConnectApiKey,
  AppStoreConnectError,
  type AppStoreConnectRequest,
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
 * What a tester can do with a build: `processing` until App Store Connect has
 * processed it, `missing-compliance` until someone answers export compliance,
 * and `ready` once it installs. `failed` and `expired` never install.
 */
export type TestFlightBuildState =
  | "processing"
  | "ready"
  | "missing-compliance"
  | "failed"
  | "expired";

/** A build App Store Connect lists, as one read of `/v1/builds` says. */
export interface TestFlightBuildStatus {
  readonly buildId: string;
  /** The audience App Store Connect holds it for, or null until it says. */
  readonly audience: string | null;
  readonly state: TestFlightBuildState;
  /** When TestFlight stops offering it, or null until it says. */
  readonly expiresAtMs: number | null;
}

interface BuildsResponse {
  readonly data: readonly {
    readonly id: string;
    readonly attributes?: {
      readonly buildAudienceType?: string | null;
      readonly processingState?: string | null;
      readonly expirationDate?: string | null;
      readonly expired?: boolean | null;
    };
  }[];
  readonly included?: readonly {
    readonly type?: string;
    readonly attributes?: { readonly internalBuildState?: string | null };
  }[];
}

const STATE_OF_INTERNAL_BUILD: Readonly<Record<string, TestFlightBuildState>> =
  {
    MISSING_EXPORT_COMPLIANCE: "missing-compliance",
    IN_EXPORT_COMPLIANCE_REVIEW: "missing-compliance",
    PROCESSING: "processing",
    PROCESSING_EXCEPTION: "failed",
    EXPIRED: "expired",
  };

/**
 * One read of a version and build number: its audience, processing state,
 * expiry, and internal testing state. Null while App Store Connect lists none.
 */
const readBuildStatus = async (
  request: AppStoreConnectRequest,
  {
    appId,
    shortVersion,
    bundleVersion,
  }: { appId: string; shortVersion: string | null; bundleVersion: string },
): Promise<TestFlightBuildStatus | null> => {
  const { data, included } = await retrying(() =>
    request<BuildsResponse>(
      "Reading the build",
      "GET",
      `/v1/builds?${new URLSearchParams({
        "filter[app]": appId,
        "filter[version]": bundleVersion,
        ...(shortVersion === null
          ? {}
          : { "filter[preReleaseVersion.version]": shortVersion }),
        "fields[builds]":
          "buildAudienceType,processingState,expirationDate,expired,buildBetaDetail",
        include: "buildBetaDetail",
        "fields[buildBetaDetails]": "internalBuildState",
        limit: "1",
      })}`,
    ),
  );
  const build = data[0];
  if (!build) return null;
  const internal = included?.find(({ type }) => type === "buildBetaDetails")
    ?.attributes?.internalBuildState;
  const processing = build.attributes?.processingState;
  const expiration = build.attributes?.expirationDate;
  return {
    buildId: build.id,
    audience: build.attributes?.buildAudienceType ?? null,
    state: build.attributes?.expired
      ? "expired"
      : processing === "PROCESSING" || !processing
        ? "processing"
        : processing !== "VALID"
          ? "failed"
          : (STATE_OF_INTERNAL_BUILD[internal ?? ""] ?? "ready"),
    expiresAtMs: expiration ? Date.parse(expiration) : null,
  };
};

/**
 * Fails unless App Store Connect holds the uploaded sandbox build for internal
 * testing only, as `buildAudienceType` says once the build is listed, and
 * returns what that read says of it.
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
}): Promise<
  TestFlightBuildStatus & { appId: string; testFlightUrl: string }
> => {
  const [info, privateKey] = await Promise.all([
    readIpaInfo(ipaPath),
    readPrivateKey(apiKey.keyPath),
  ]);
  const request = createAppStoreConnectRequest({ apiKey, privateKey, fetch });
  const { app, testFlightUrl } = await findApp(request, info.bundleId);
  const label = `${info.shortVersion} (${info.bundleVersion})`;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const status = await readBuildStatus(request, {
      appId: app.id,
      shortVersion: info.shortVersion,
      bundleVersion: info.bundleVersion,
    });
    if (status?.audience === "INTERNAL_ONLY") {
      return { ...status, appId: app.id, testFlightUrl };
    }
    if (status?.audience) {
      throw new Error(
        `App Store Connect holds sandbox build ${label} for ${status.audience}, not INTERNAL_ONLY.\nExpire it in TestFlight:\n${testFlightUrl}`,
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

/** An internal TestFlight group of an app. */
export interface InternalBetaGroup {
  readonly id: string;
  readonly name: string;
  /** A group that takes every build needs no build added to it. */
  readonly hasAccessToAllBuilds: boolean;
}

/**
 * The internal TestFlight group named `name`, read before anything is built.
 * An external group is refused: its builds go to Beta App Review, and a sandbox
 * build is for internal testing only.
 */
export const findInternalBetaGroup = async ({
  bundleId,
  name,
  apiKey,
  fetch = globalThis.fetch,
}: {
  bundleId: string;
  name: string;
  apiKey: AppStoreConnectApiKey;
  fetch?: typeof globalThis.fetch;
}): Promise<InternalBetaGroup> => {
  const privateKey = await readPrivateKey(apiKey.keyPath);
  const request = createAppStoreConnectRequest({ apiKey, privateKey, fetch });
  const { app, testFlightUrl } = await findApp(request, bundleId);
  return readInternalBetaGroup(request, {
    appId: app.id,
    bundleId,
    name,
    testFlightUrl,
  });
};

/** The group named `name` of an app, refused unless it is internal. */
const readInternalBetaGroup = async (
  request: AppStoreConnectRequest,
  {
    appId,
    bundleId,
    name,
    testFlightUrl,
  }: { appId: string; bundleId: string; name: string; testFlightUrl: string },
): Promise<InternalBetaGroup> => {
  const { data } = await retrying(() =>
    request<{
      data: {
        id: string;
        attributes?: {
          name?: string;
          isInternalGroup?: boolean;
          hasAccessToAllBuilds?: boolean;
        };
      }[];
    }>(
      "Reading the TestFlight groups",
      "GET",
      `/v1/betaGroups?${new URLSearchParams({
        "filter[app]": appId,
        "filter[name]": name,
        "fields[betaGroups]": "name,isInternalGroup,hasAccessToAllBuilds",
        limit: "200",
      })}`,
    ),
  );
  const group = data.find(({ attributes }) => attributes?.name === name);
  if (!group) {
    throw new Error(
      `App Store Connect has no TestFlight group ${name} for ${bundleId}.\nCreate it as an internal group:\n${testFlightUrl}`,
    );
  }
  if (group.attributes?.isInternalGroup !== true) {
    throw new Error(
      `TestFlight group ${name} is external, and a sandbox build is for internal testing only.\nName an internal group.`,
    );
  }
  return {
    id: group.id,
    name,
    hasAccessToAllBuilds: group.attributes.hasAccessToAllBuilds === true,
  };
};

/** How long a build's processing may hold up its group and What to Test. */
const DISTRIBUTION_TIMEOUT_MS = 15 * 60_000;

/** What to Test's locale: the language the CLI writes it in. */
const WHAT_TO_TEST_LOCALE = "en-US";

/**
 * Adds a processed build to its internal group and sets its What to Test, which
 * App Store Connect takes once the build is processed. A build still processing
 * after `timeoutMs` keeps its upload: a warning says what to do by hand. Returns
 * the build's state.
 */
export const distributeTestFlightBuild = async ({
  build: { appId, shortVersion, bundleVersion, testFlightUrl },
  group,
  whatToTest,
  apiKey,
  fetch = globalThis.fetch,
  pollIntervalMs = 15_000,
  timeoutMs = DISTRIBUTION_TIMEOUT_MS,
}: {
  build: {
    appId: string;
    shortVersion: string;
    bundleVersion: string;
    testFlightUrl: string;
  };
  group?: InternalBetaGroup;
  whatToTest?: string;
  apiKey: AppStoreConnectApiKey;
  fetch?: typeof globalThis.fetch;
  pollIntervalMs?: number;
  timeoutMs?: number;
}): Promise<TestFlightBuildStatus | null> => {
  const privateKey = await readPrivateKey(apiKey.keyPath);
  const request = createAppStoreConnectRequest({ apiKey, privateKey, fetch });
  const build = { appId, shortVersion, bundleVersion, testFlightUrl };
  const status = await waitUntilProcessed(
    request,
    build,
    await readBuildStatus(request, build),
    {
      pollIntervalMs,
      timeoutMs,
      unset: "its testers and What to Test",
    },
  );
  if (!status || status.state === "processing") return status;
  const { buildId } = status;
  if (group && !group.hasAccessToAllBuilds) {
    await addBuildToGroup(request, build, buildId, group);
  }
  if (whatToTest !== undefined) {
    await setWhatToTest(request, buildId, whatToTest);
  }
  return status;
};

/**
 * Reads the build until App Store Connect has processed it, from the status a
 * read already has, for what it takes only then. A build still processing after
 * `timeoutMs` keeps its upload: a warning says what is `unset`. One that can't
 * be processed fails.
 */
const waitUntilProcessed = async (
  request: AppStoreConnectRequest,
  build: {
    appId: string;
    shortVersion: string;
    bundleVersion: string;
    testFlightUrl: string;
  },
  listed: TestFlightBuildStatus | null,
  {
    pollIntervalMs,
    timeoutMs,
    unset,
  }: { pollIntervalMs: number; timeoutMs: number; unset: string },
): Promise<TestFlightBuildStatus | null> => {
  const label = `${build.shortVersion} (${build.bundleVersion})`;
  const deadline = Date.now() + timeoutMs;
  let status = listed;
  while (!status || status.state === "processing") {
    if (Date.now() >= deadline) {
      p.log.warn(
        `App Store Connect is still processing build ${label}, so ${unset} aren't set.\nSet them in TestFlight:\n${build.testFlightUrl}`,
      );
      return status;
    }
    await sleep(pollIntervalMs);
    status = await readBuildStatus(request, build);
  }
  if (status.state === "failed") {
    throw new Error(
      `App Store Connect couldn't process build ${label}.\nCheck it in TestFlight:\n${build.testFlightUrl}`,
    );
  }
  return status;
};

const addBuildToGroup = (
  request: AppStoreConnectRequest,
  {
    shortVersion,
    bundleVersion,
  }: { shortVersion: string; bundleVersion: string },
  buildId: string,
  group: InternalBetaGroup,
) =>
  retrying(() =>
    request(
      `Adding build ${shortVersion} (${bundleVersion}) to ${group.name}`,
      "POST",
      `/v1/betaGroups/${group.id}/relationships/builds`,
      { data: [{ type: "builds", id: buildId }] },
    ),
  );

/**
 * What became of a group for a build on TestFlight: `added`, in a group that
 * `takes-every-build` without being asked, `pending` while the build processes,
 * and `not-offered` for a build no tester could get.
 */
export type TestFlightGroupOutcome =
  | "added"
  | "takes-every-build"
  | "pending"
  | "not-offered";

/**
 * Applies an internal group to a build already on TestFlight, as an upload does,
 * so a reused build reaches the group named now. One process reads the app, the
 * build and the group once each, and App Store Connect can't say which groups
 * hold a build, so it adds the build, which a group already holding it takes
 * again. A build not `isOffered` gets nothing: it needs a new build, which
 * checks the group itself. A build still processing waits as an upload's does,
 * and the next run applies the group again.
 */
export const applyTestFlightGroup = async ({
  bundleId,
  shortVersion,
  bundleVersion,
  name,
  isOffered,
  apiKey,
  fetch = globalThis.fetch,
  pollIntervalMs = 15_000,
  timeoutMs = DISTRIBUTION_TIMEOUT_MS,
}: {
  bundleId: string;
  shortVersion: string;
  bundleVersion: string;
  name: string;
  /** Whether a tester can still get the build, as its status says. */
  isOffered: (status: TestFlightBuildStatus | null) => boolean;
  apiKey: AppStoreConnectApiKey;
  fetch?: typeof globalThis.fetch;
  pollIntervalMs?: number;
  timeoutMs?: number;
}): Promise<{
  testFlightUrl: string;
  status: TestFlightBuildStatus | null;
  outcome: TestFlightGroupOutcome;
}> => {
  const privateKey = await readPrivateKey(apiKey.keyPath);
  const request = createAppStoreConnectRequest({ apiKey, privateKey, fetch });
  const { app, testFlightUrl } = await findApp(request, bundleId);
  const build = {
    appId: app.id,
    shortVersion,
    bundleVersion,
    testFlightUrl,
  };
  const listed = await readBuildStatus(request, build);
  if (!isOffered(listed)) {
    return { testFlightUrl, status: listed, outcome: "not-offered" };
  }
  const group = await readInternalBetaGroup(request, {
    appId: app.id,
    bundleId,
    name,
    testFlightUrl,
  });
  if (group.hasAccessToAllBuilds) {
    return { testFlightUrl, status: listed, outcome: "takes-every-build" };
  }
  const status = await waitUntilProcessed(request, build, listed, {
    pollIntervalMs,
    timeoutMs,
    unset: "its testers",
  });
  if (!status || status.state === "processing") {
    return { testFlightUrl, status, outcome: "pending" };
  }
  await addBuildToGroup(request, build, status.buildId, group);
  return { testFlightUrl, status, outcome: "added" };
};

/** Sets a build's What to Test: creates it, or updates the one a rerun left. */
const setWhatToTest = async (
  request: AppStoreConnectRequest,
  buildId: string,
  whatsNew: string,
) => {
  try {
    await retrying(() =>
      request("Setting What to Test", "POST", "/v1/betaBuildLocalizations", {
        data: {
          type: "betaBuildLocalizations",
          attributes: { locale: WHAT_TO_TEST_LOCALE, whatsNew },
          relationships: {
            build: { data: { type: "builds", id: buildId } },
          },
        },
      }),
    );
  } catch (error) {
    if (!(error instanceof AppStoreConnectError) || error.status !== 409) {
      throw error;
    }
    const { data } = await retrying(() =>
      request<{ data: { id: string; attributes?: { locale?: string } }[] }>(
        "Reading What to Test",
        "GET",
        `/v1/builds/${buildId}/betaBuildLocalizations?${new URLSearchParams({
          "fields[betaBuildLocalizations]": "locale",
          limit: "200",
        })}`,
      ),
    );
    const existing = data.find(
      ({ attributes }) => attributes?.locale === WHAT_TO_TEST_LOCALE,
    );
    if (!existing) throw error;
    await retrying(() =>
      request(
        "Setting What to Test",
        "PATCH",
        `/v1/betaBuildLocalizations/${existing.id}`,
        {
          data: {
            type: "betaBuildLocalizations",
            id: existing.id,
            attributes: { whatsNew },
          },
        },
      ),
    );
  }
};

/**
 * What App Store Connect says of a build a run recorded as uploaded, which a
 * later run reuses: its page, and its state and expiry, or a null status when
 * it no longer lists the build.
 */
export const readTestFlightBuildStatus = async ({
  bundleId,
  shortVersion,
  bundleVersion,
  apiKey,
  fetch = globalThis.fetch,
}: {
  bundleId: string;
  shortVersion: string | null;
  bundleVersion: string;
  apiKey: AppStoreConnectApiKey;
  fetch?: typeof globalThis.fetch;
}): Promise<{
  testFlightUrl: string;
  status: TestFlightBuildStatus | null;
}> => {
  const privateKey = await readPrivateKey(apiKey.keyPath);
  const request = createAppStoreConnectRequest({ apiKey, privateKey, fetch });
  const { app, testFlightUrl } = await findApp(request, bundleId);
  return {
    testFlightUrl,
    status: await readBuildStatus(request, {
      appId: app.id,
      shortVersion,
      bundleVersion,
    }),
  };
};
