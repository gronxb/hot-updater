import { checkPlayAccess, type PlayAccess } from "@hot-updater/android-helper";
import {
  type ConfigResponse,
  readLoadedHotUpdaterEnv,
  withCredentialResolver,
} from "@hot-updater/cli-tools";

import { ui } from "../../utils/cli-ui";
import {
  describePlayAccess,
  formatPlayChecks,
  GOOGLE_PLAY_GUIDE_URL,
  type PlayCheck,
} from "../../utils/native/playServiceAccount";

/** How long doctor waits for each Google request. */
const PLAY_TIMEOUT_MS = 10_000;

/** What doctor found for one Android package, or why it couldn't check. */
export type GooglePlayPackageAccess =
  | PlayAccess
  | { readonly status: "unchecked"; readonly reason: string };

/** The stored Play service account's access to each Android package. */
export interface GooglePlayStatus {
  readonly packages: readonly {
    readonly packageName: string;
    readonly access: GooglePlayPackageAccess;
  }[];
}

/**
 * The packages the config's Android schemes release to Google Play: each
 * scheme that builds a release `.aab`, by its application ID.
 */
const playPackageNames = (config: ConfigResponse): string[] => [
  ...new Set(
    Object.values(config.nativeBuild?.android ?? {}).flatMap((scheme) =>
      scheme &&
      scheme.aab !== false &&
      !/debug$/iu.test(scheme.variant ?? "Release")
        ? [scheme.applicationId ?? scheme.packageName]
        : [],
    ),
  ),
];

/**
 * When `play-service-account` resolves, from the environment or the
 * config's `secrets` adapter, whether it reaches each package the config
 * releases to Google Play: an edit opened and deleted, changing nothing.
 * Undefined when there is no such package or no key; doctor reports, and
 * never fails, on what it finds.
 */
export const checkGooglePlay = async (
  config: ConfigResponse,
  { cwd, fetch }: { cwd: string; fetch?: typeof globalThis.fetch },
): Promise<GooglePlayStatus | undefined> => {
  const packageNames = playPackageNames(config);
  if (packageNames.length === 0) return undefined;
  // A report never waits on a slow endpoint.
  const fetchWithTimeout: typeof globalThis.fetch = (input, init) =>
    (fetch ?? globalThis.fetch)(input, {
      ...init,
      signal: AbortSignal.timeout(PLAY_TIMEOUT_MS),
    });
  return withCredentialResolver(
    async (resolver) => {
      const serviceAccount = await resolver
        .resolve({ kind: "play-service-account" })
        .catch(() => undefined);
      if (!serviceAccount) return undefined;
      return {
        packages: await Promise.all(
          packageNames.map(async (packageName) => ({
            packageName,
            access: await checkPlayAccess({
              serviceAccount,
              packageName,
              fetch: fetchWithTimeout,
            }).catch(
              (error: unknown): GooglePlayPackageAccess => ({
                status: "unchecked",
                reason: error instanceof Error ? error.message : String(error),
              }),
            ),
          })),
        ),
      };
    },
    {
      env: await readLoadedHotUpdaterEnv(cwd),
      secrets: config.secrets,
      cwd,
    },
  );
};

/**
 * Doctor's Google Play row: a line per package, the invite or the first
 * upload under one that fails, and the guide when any does.
 */
export const formatGooglePlayStatus = ({
  packages,
}: GooglePlayStatus): { readonly ready: boolean; readonly text: string } => {
  const checks = packages.map(
    ({ packageName, access }): PlayCheck =>
      access.status === "unchecked"
        ? {
            ok: false,
            label: packageName,
            detail: "can't check",
            lines: access.reason.split("\n"),
          }
        : describePlayAccess(access, packageName),
  );
  const ready = checks.every(({ ok }) => ok);
  return {
    ready,
    text: [
      "Google Play",
      ...formatPlayChecks(checks),
      ...(ready ? [] : [`Guide: ${ui.path(GOOGLE_PLAY_GUIDE_URL)}`]),
    ].join("\n"),
  };
};
