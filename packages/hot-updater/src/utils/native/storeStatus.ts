import {
  playTestingUrl,
  readPlayInternalRelease,
  resolvePlayUploadServiceAccount,
} from "@hot-updater/android-helper";
import {
  applyTestFlightGroup,
  readTestFlightBuildStatus,
  resolveTestFlightUploadKey,
  type TestFlightBuildState,
  type TestFlightGroupOutcome,
} from "@hot-updater/apple-helper";
import {
  getCwd,
  type loadConfig,
  readLoadedHotUpdaterEnv,
  withCredentialResolver,
} from "@hot-updater/cli-tools";
import type {
  NativeBuildAndroidScheme,
  NativeBuildRow,
  NativeBuildSubmissionDestination,
  Platform,
} from "@hot-updater/plugin-core";

import { resolveSandboxApplicationId } from "../version/getAndroidVersion";

/**
 * What a store says of a build a run submitted:
 * - TestFlight's states, as `TestFlightBuildState` says;
 * - `ready` or `draft` on Google Play's internal track, where a release on an
 *   app Play Console hasn't published is a draft to roll out by hand;
 * - `replaced` once a newer release took the internal track, which testers get
 *   instead, and `missing` once TestFlight no longer lists the build.
 */
export type StoreState =
  | TestFlightBuildState
  | "draft"
  | "replaced"
  | "missing";

/** A submitted build in its store, as `--json` prints it. */
export interface StoreStatus {
  readonly destination: NativeBuildSubmissionDestination;
  /** The store's page of the app, or null when it couldn't be read. */
  readonly url: string | null;
  /** The store's label of the build, such as `1.7.0 (66)`. */
  readonly version: string | null;
  /** Null when the store couldn't be read: the record is all there is. */
  readonly state: StoreState | null;
  /** When the store stops offering the build, or null when it doesn't say. */
  readonly expiresAtMs: number | null;
  /** Whether a tester can still get this build, so it needs no new upload. */
  readonly reusable: boolean;
}

/** How close to its expiry a TestFlight build is built again. */
const RENEW_BEFORE_EXPIRY_MS = 7 * 24 * 60 * 60 * 1_000;

const GONE: ReadonlySet<StoreState> = new Set([
  "failed",
  "expired",
  "replaced",
  "missing",
]);

/** Whether a tester can get a build in this state for long enough. */
export const isStoreBuildReusable = (
  state: StoreState | null,
  expiresAtMs: number | null,
  nowMs: number = Date.now(),
): boolean =>
  !(state !== null && GONE.has(state)) &&
  !(expiresAtMs !== null && expiresAtMs - nowMs < RENEW_BEFORE_EXPIRY_MS);

/** The application ID a scheme releases to Google Play as. */
export const playPackageName = (
  scheme: Pick<
    NativeBuildAndroidScheme,
    "sandbox" | "variant" | "applicationId" | "packageName" | "appModuleName"
  >,
): Promise<string> | string =>
  scheme.sandbox
    ? resolveSandboxApplicationId(scheme)
    : (scheme.applicationId ?? scheme.packageName);

/** `1.7.0` and `66` of a store's label such as `1.7.0 (66)`. */
const parseStoreVersion = (build: NativeBuildRow) => {
  const match = /^(.+) \((.+)\)$/u.exec(build.submitted_version ?? "");
  return {
    shortVersion: match?.[1] ?? null,
    buildNumber: match?.[2] ?? build.build_number ?? build.submitted_version,
  };
};

/** A build on TestFlight, as App Store Connect's word on it says. */
const testFlightStatus = (
  build: NativeBuildRow,
  url: string,
  status: {
    readonly state: TestFlightBuildState;
    readonly expiresAtMs: number | null;
  } | null,
): StoreStatus => {
  const state = status?.state ?? "missing";
  const expiresAtMs = status?.expiresAtMs ?? null;
  return {
    destination: "testflight",
    url,
    version: build.submitted_version,
    state,
    expiresAtMs,
    reusable: isStoreBuildReusable(state, expiresAtMs),
  };
};

const unread = (build: NativeBuildRow): StoreStatus => ({
  destination: build.submitted_to!,
  url: null,
  version: build.submitted_version,
  state: null,
  expiresAtMs: null,
  reusable: true,
});

/**
 * Reads the store's own word on a build this project submitted, for a run that
 * would reuse it: nothing in the database holds it, or the store's page. A store
 * that can't be read fails nothing: the build is on its record, with no state.
 */
export const readStoreStatus = async (
  config: Awaited<ReturnType<typeof loadConfig>>,
  {
    platform,
    scheme,
    build,
    fetch,
    onError,
  }: {
    platform: Platform;
    scheme: string;
    build: NativeBuildRow;
    fetch?: typeof globalThis.fetch;
    onError: (error: unknown) => void;
  },
): Promise<StoreStatus> => {
  const { shortVersion, buildNumber } = parseStoreVersion(build);
  const cwd = getCwd();
  try {
    if (buildNumber === null) return unread(build);
    return await withCredentialResolver(
      async (credentials): Promise<StoreStatus> => {
        if (platform === "ios") {
          const iosScheme = config.nativeBuild.ios[scheme]!;
          const apiKey = await credentials.resolve(
            await resolveTestFlightUploadKey({ scheme, iosScheme }),
          );
          const { testFlightUrl, status } = await readTestFlightBuildStatus({
            bundleId: iosScheme.bundleIdentifier,
            shortVersion,
            bundleVersion: buildNumber,
            apiKey,
            ...(fetch ? { fetch } : {}),
          });
          return testFlightStatus(build, testFlightUrl, status);
        }
        const androidScheme = config.nativeBuild.android[scheme]!;
        const packageName = await playPackageName(androidScheme);
        const serviceAccount = await credentials.resolve(
          resolvePlayUploadServiceAccount({ scheme, androidScheme }),
        );
        const release = await readPlayInternalRelease({
          versionCode: Number(buildNumber),
          packageName,
          serviceAccount,
          ...(fetch ? { fetch } : {}),
        });
        const state: StoreState =
          release === null
            ? "replaced"
            : release === "draft"
              ? "draft"
              : "ready";
        return {
          destination: "play-internal",
          url: playTestingUrl(packageName),
          version: build.submitted_version,
          state,
          expiresAtMs: null,
          reusable: isStoreBuildReusable(state, null),
        };
      },
      {
        env: await readLoadedHotUpdaterEnv(cwd),
        secrets: config.secrets,
        cwd,
      },
    );
  } catch (error) {
    onError(error);
    return unread(build);
  }
};

/**
 * Applies an internal TestFlight group to a build this project uploaded. Unlike
 * a status read, a failure throws: the group was asked for, and no tester in it
 * would get the build. A build testers can't get anymore is left alone.
 */
export const applyStoreTestFlightGroup = async (
  config: Awaited<ReturnType<typeof loadConfig>>,
  {
    scheme,
    build,
    group,
    fetch,
  }: {
    scheme: string;
    build: NativeBuildRow;
    group: string;
    fetch?: typeof globalThis.fetch;
  },
): Promise<StoreStatus & { readonly group: TestFlightGroupOutcome }> => {
  const { shortVersion, buildNumber } = parseStoreVersion(build);
  if (shortVersion === null || buildNumber === null) {
    throw new Error(
      `Native build ${build.id} records no TestFlight version.\nAdd it to ${group} in TestFlight.`,
    );
  }
  const cwd = getCwd();
  return withCredentialResolver(
    async (credentials) => {
      const iosScheme = config.nativeBuild.ios[scheme]!;
      const { testFlightUrl, status, outcome } = await applyTestFlightGroup({
        bundleId: iosScheme.bundleIdentifier,
        shortVersion,
        bundleVersion: buildNumber,
        name: group,
        isOffered: (listed) => testFlightStatus(build, "", listed).reusable,
        apiKey: await credentials.resolve(
          await resolveTestFlightUploadKey({ scheme, iosScheme }),
        ),
        ...(fetch ? { fetch } : {}),
      });
      return {
        ...testFlightStatus(build, testFlightUrl, status),
        group: outcome,
      };
    },
    {
      env: await readLoadedHotUpdaterEnv(cwd),
      secrets: config.secrets,
      cwd,
    },
  );
};
