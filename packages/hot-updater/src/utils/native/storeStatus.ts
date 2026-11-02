import {
  playTestingUrl,
  readPlayInternalRelease,
  resolvePlayUploadServiceAccount,
} from "@hot-updater/android-helper";
import {
  applyTestFlightGroup,
  readIpaHasExportComplianceKey,
  readTestFlightBuildStatus,
  resolveTestFlightUploadKey,
  type TestFlightBuildState,
  type TestFlightBuildStatus,
  type TestFlightGroupOutcome,
  type UploadToTestFlightResult,
} from "@hot-updater/apple-helper";
import {
  getCwd,
  type loadConfig,
  p,
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
import { storeVersionLabel } from "./nativeBuildSubmission";

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
 * A build this run uploaded, as App Store Connect's word on it says. One it
 * doesn't list yet is on its way, where a recorded build it doesn't list is gone.
 */
export const uploadedTestFlightStatus = (
  uploaded: UploadToTestFlightResult,
  status: {
    readonly state: TestFlightBuildState;
    readonly expiresAtMs: number | null;
  } | null,
): StoreStatus => {
  const state = status?.state ?? "processing";
  const expiresAtMs = status?.expiresAtMs ?? null;
  return {
    destination: "testflight",
    url: uploaded.testFlightUrl,
    version: storeVersionLabel(uploaded.shortVersion, uploaded.bundleVersion),
    state,
    expiresAtMs,
    reusable: isStoreBuildReusable(state, expiresAtMs),
  };
};

/**
 * Reads, once, what App Store Connect says of a build it accepted from this run.
 * A failed read fails nothing: the upload stands, with no state and an undefined
 * `status`, and a warning says why.
 */
export const readUploadedTestFlightStatus = async ({
  bundleId,
  uploaded,
  apiKey,
}: {
  bundleId: string;
  uploaded: UploadToTestFlightResult;
  apiKey: Parameters<typeof readTestFlightBuildStatus>[0]["apiKey"];
}): Promise<{
  store: StoreStatus;
  status: TestFlightBuildStatus | null | undefined;
}> => {
  try {
    const { status } = await readTestFlightBuildStatus({
      bundleId,
      shortVersion: uploaded.shortVersion,
      bundleVersion: uploaded.bundleVersion,
      apiKey,
    });
    return { store: uploadedTestFlightStatus(uploaded, status), status };
  } catch (error) {
    p.log.warn(
      `Couldn't read the build's state from App Store Connect.\n${error instanceof Error ? error.message : String(error)}`,
    );
    return {
      store: { ...uploadedTestFlightStatus(uploaded, null), state: null },
      status: undefined,
    };
  }
};

/**
 * What to tell whoever uploaded a build about export compliance, or null with
 * nothing to tell. The state may lag the upload, so a build still processing is
 * judged by the `.ipa`, which an unreadable `.ipa` leaves unsaid. `status` is
 * undefined when nothing read the state.
 */
export const testFlightUploadNotice = async ({
  uploaded,
  status,
  ipaPath,
}: {
  uploaded: UploadToTestFlightResult;
  status: TestFlightBuildStatus | null | undefined;
  ipaPath: string;
}): Promise<string | null> => {
  const version = storeVersionLabel(
    uploaded.shortVersion,
    uploaded.bundleVersion,
  );
  const url = uploaded.testFlightUrl;
  if (status?.inExportComplianceReview) {
    return `Testers can't install ${version} yet: Apple is reviewing its export compliance.\n${url}`;
  }
  if (status?.state === "missing-compliance") {
    return [
      `Testers can't install ${version}: it's waiting on export compliance.`,
      "Answer it in App Store Connect:",
      url,
      "Or set ITSAppUsesNonExemptEncryption in Info.plist for later builds.",
    ].join("\n");
  }
  const processing =
    status === undefined
      ? uploaded.state === "PROCESSING"
      : status === null || status.state === "processing";
  if (!processing) return null;
  const hasKey = await readIpaHasExportComplianceKey(ipaPath).catch(() => true);
  return hasKey
    ? null
    : `${version} is processing. Without ITSAppUsesNonExemptEncryption in Info.plist, testers can't install it until export compliance is answered in App Store Connect:\n${url}`;
};

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
