import { resolveTestFlightUploadKey } from "@hot-updater/apple-helper";
import { loadConfig, nonInteractiveReason, p } from "@hot-updater/cli-tools";

import { printBanner } from "@/utils/printBanner";

import { buildIosNative } from "./buildNative";

/** Where the docs show a scheme that uploads to TestFlight. */
const TESTFLIGHT_DOCS =
  "https://hot-updater.dev/docs/guides/native-build#upload-to-testflight";

export interface TestFlightOptions {
  /** The `nativeBuild.ios` scheme; else the one that uploads, or a prompt. */
  readonly scheme?: string;
  /** Registers the build, as a patch base `native-build find` sees: on unless `--no-register`. */
  readonly register?: boolean;
  readonly json?: boolean;
  readonly outputPath?: string;
}

/**
 * The `nativeBuild.ios` schemes whose build TestFlight takes, as
 * `build:ios --upload testflight` checks them before the build
 * (`resolveTestFlightUploadKey`), and why each other one is not.
 */
const testFlightSchemes = async () => {
  const config = await loadConfig({ platform: "ios", channel: "" });
  const uploadable: string[] = [];
  const refused: string[] = [];
  for (const [scheme, iosScheme] of Object.entries(config.nativeBuild.ios).sort(
    ([a], [b]) => a.localeCompare(b),
  )) {
    try {
      resolveTestFlightUploadKey({ scheme, iosScheme });
      uploadable.push(scheme);
    } catch (error) {
      refused.push(error instanceof Error ? error.message : String(error));
    }
  }
  return { uploadable, refused };
};

/**
 * The scheme `testflight` builds: `--scheme`, or else the only
 * `nativeBuild.ios` scheme that uploads to TestFlight, or the one picked at
 * a terminal among several. Undefined after reporting why there is none,
 * with exit code 1.
 */
const resolveScheme = async (
  scheme: string | undefined,
): Promise<string | undefined> => {
  if (scheme !== undefined) return scheme;
  const { uploadable, refused } = await testFlightSchemes();
  const fail = (message: string) => {
    p.log.error(message);
    process.exitCode = 1;
    return undefined;
  };

  if (uploadable.length === 0) {
    return fail(
      [
        "No nativeBuild.ios scheme in hot-updater.config.ts uploads to TestFlight.",
        ...refused,
        `Add a device scheme with signing.ascApiKey, as ${TESTFLIGHT_DOCS} shows, then run npx hot-updater testflight.`,
      ].join("\n"),
    );
  }
  const [only] = uploadable;
  if (uploadable.length === 1 && only !== undefined) {
    p.log.info(
      `Scheme ${only}: the only nativeBuild.ios scheme that uploads to TestFlight.`,
    );
    return only;
  }

  const reason = nonInteractiveReason();
  if (reason !== undefined) {
    return fail(
      `Several nativeBuild.ios schemes upload to TestFlight: ${uploadable.join(", ")}. Hot Updater asks which one only at a terminal, never ${reason}: run npx hot-updater testflight --scheme <${uploadable.join(" | ")}>.`,
    );
  }
  const picked = await p.select({
    message: "Which scheme do you upload to TestFlight?",
    options: uploadable.map((value) => ({ value, label: value })),
  });
  if (p.isCancel(picked)) return fail("No scheme was picked.");
  return picked;
};

/**
 * `testflight`: the shortcut for `build:ios --scheme <scheme> --upload
 * testflight --register`, with the same handler. It registers the build
 * unless `--no-register`, and without `--scheme` picks the scheme that
 * uploads to TestFlight.
 */
export const handleTestFlight = async ({
  scheme,
  register = true,
  ...options
}: TestFlightOptions): Promise<void> => {
  printBanner();
  const resolved = await resolveScheme(scheme);
  if (resolved === undefined) return;
  await buildIosNative({
    ...options,
    scheme: resolved,
    // The scheme is picked above: build:ios asks nothing more.
    interactive: false,
    upload: "testflight",
    register,
  });
};
