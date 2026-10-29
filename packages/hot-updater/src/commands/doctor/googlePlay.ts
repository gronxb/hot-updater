import { checkPlayAccess, type PlayAccess } from "@hot-updater/android-helper";
import {
  type ConfigResponse,
  isSecretRef,
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
import { signsWithKeystore } from "../../utils/native/signingCredentials";
import { missingRequiredSecrets, type SecretsStatus } from "./secrets";

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
    /**
     * The `secret()` of the upload keystore a release of it signs with,
     * when no store or environment holds it: no `.aab` to upload.
     */
    readonly missingKeystore?: string;
  }[];
}

/** The schemes that release to Google Play: each that builds a release `.aab`. */
const playSchemes = (config: ConfigResponse) =>
  Object.values(config.nativeBuild?.android ?? {}).flatMap((scheme) =>
    scheme && scheme.aab !== false && signsWithKeystore(scheme) ? [scheme] : [],
  );

/** The application ID a scheme releases to Google Play as. */
const playPackageName = (
  scheme: ReturnType<typeof playSchemes>[number],
): string => scheme.applicationId ?? scheme.packageName;

/**
 * The upload keystore `secret()` a release of `packageName` signs with
 * that `secrets` found nowhere, as the Secrets rows report it.
 */
const missingKeystore = (
  config: ConfigResponse,
  packageName: string,
  secrets: SecretsStatus | undefined,
): string | undefined => {
  const missing = new Set(
    missingRequiredSecrets(secrets).map(({ name }) => name),
  );
  return playSchemes(config)
    .filter((scheme) => playPackageName(scheme) === packageName)
    .map(({ signing }) =>
      isSecretRef(signing?.keystore) ? signing.keystore.name : undefined,
    )
    .find((name) => name !== undefined && missing.has(name));
};

/**
 * When `play-service-account` resolves, from the environment or the
 * config's `secrets` adapter, whether it reaches each package the config
 * releases to Google Play: an edit opened and deleted, changing nothing.
 * Undefined when there is no such package or no key; doctor reports, and
 * never fails, on what it finds.
 */
export const checkGooglePlay = async (
  config: ConfigResponse,
  {
    cwd,
    fetch,
    secrets,
  }: {
    cwd: string;
    fetch?: typeof globalThis.fetch;
    /** The Secrets rows, whose missing upload keystores mark a package. */
    secrets?: SecretsStatus;
  },
): Promise<GooglePlayStatus | undefined> => {
  const packageNames = [...new Set(playSchemes(config).map(playPackageName))];
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
          packageNames.map(async (packageName) => {
            const keystore = missingKeystore(config, packageName, secrets);
            return {
              packageName,
              access: await checkPlayAccess({
                serviceAccount,
                packageName,
                fetch: fetchWithTimeout,
              }).catch(
                (error: unknown): GooglePlayPackageAccess => ({
                  status: "unchecked",
                  reason:
                    error instanceof Error ? error.message : String(error),
                }),
              ),
              ...(keystore === undefined ? {} : { missingKeystore: keystore }),
            };
          }),
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
    ({ packageName, access, missingKeystore }): PlayCheck => {
      const check: PlayCheck =
        access.status === "unchecked"
          ? {
              ok: false,
              label: packageName,
              detail: "can't check",
              lines: access.reason.split("\n"),
            }
          : describePlayAccess(access, packageName);
      if (missingKeystore === undefined) return check;
      // Play access alone doesn't upload: the build has nothing to sign with.
      return check.ok
        ? { ok: false, label: packageName, detail: "upload keystore missing" }
        : {
            ...check,
            lines: [
              ...(check.lines ?? []),
              `Upload keystore ${missingKeystore} is missing too.`,
            ],
          };
    },
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
