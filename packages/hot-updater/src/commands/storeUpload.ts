import { resolvePlayUploadServiceAccount } from "@hot-updater/android-helper";
import { resolveTestFlightUploadKey } from "@hot-updater/apple-helper";
import { loadConfig, nonInteractiveReason, p } from "@hot-updater/cli-tools";
import type { Platform } from "@hot-updater/plugin-core";

import { printBanner } from "@/utils/printBanner";

import { buildAndroidNative, buildIosNative } from "./buildNative";

/** `testflight` and `google-play upload`: build options they pass on. */
export interface StoreUploadOptions {
  /** The scheme; else the one that uploads to the store, or a prompt. */
  readonly scheme?: string;
  /** Registers the build, as a patch base `native-build find` sees: on unless `--no-register`. */
  readonly register?: boolean;
  readonly json?: boolean;
  readonly outputPath?: string;
}

/** What each store shortcut builds, and how it names the store. */
interface StoreShortcut {
  readonly platform: Platform;
  /** The store, as messages name it. */
  readonly store: string;
  /** The command, after `npx hot-updater`. */
  readonly command: string;
  /** How to add a scheme the store takes. */
  readonly addScheme: string;
  /**
   * Throws for a scheme whose build the store would not take, as the
   * build's own `--upload` checks it before the prebuild.
   */
  readonly check: (scheme: string, config: never) => void;
}

const TESTFLIGHT: StoreShortcut = {
  platform: "ios",
  store: "TestFlight",
  command: "testflight",
  addScheme:
    "Add a device scheme with signing.ascApiKey, as https://hot-updater.dev/docs/guides/native-build#upload-to-testflight shows",
  check: (scheme, iosScheme) =>
    resolveTestFlightUploadKey({ scheme, iosScheme }),
};

const GOOGLE_PLAY: StoreShortcut = {
  platform: "android",
  store: "Google Play",
  command: "google-play upload",
  addScheme:
    "Add a release scheme that builds an .aab, signed with signing.keystore, as https://hot-updater.dev/docs/guides/native-build#upload-to-google-play shows",
  check: (scheme, androidScheme) =>
    resolvePlayUploadServiceAccount({ scheme, androidScheme }),
};

/**
 * The config's schemes of the shortcut's platform whose build the store
 * takes, and why each other one is not.
 */
const storeSchemes = async ({ platform, check }: StoreShortcut) => {
  const config = await loadConfig({ platform, channel: "" });
  const uploadable: string[] = [];
  const refused: string[] = [];
  const schemes: Record<string, unknown> = config.nativeBuild[platform];
  for (const [scheme, schemeConfig] of Object.entries(schemes).sort(
    ([a], [b]) => a.localeCompare(b),
  )) {
    try {
      check(scheme, schemeConfig as never);
      uploadable.push(scheme);
    } catch (error) {
      refused.push(error instanceof Error ? error.message : String(error));
    }
  }
  return { uploadable, refused };
};

/**
 * The scheme a store shortcut builds: `--scheme`, or else the only scheme
 * that uploads to the store, or the one picked at a terminal among
 * several. Undefined after reporting why there is none, with exit code 1.
 */
const resolveScheme = async (
  shortcut: StoreShortcut,
  scheme: string | undefined,
): Promise<string | undefined> => {
  if (scheme !== undefined) return scheme;
  const { platform, store, command } = shortcut;
  const { uploadable, refused } = await storeSchemes(shortcut);
  const fail = (message: string) => {
    p.log.error(message);
    process.exitCode = 1;
    return undefined;
  };

  if (uploadable.length === 0) {
    return fail(
      [
        `No nativeBuild.${platform} scheme in hot-updater.config.ts uploads to ${store}.`,
        ...refused,
        `${shortcut.addScheme}, then run npx hot-updater ${command}.`,
      ].join("\n"),
    );
  }
  const [only] = uploadable;
  if (uploadable.length === 1 && only !== undefined) {
    p.log.info(
      `Scheme ${only}: the only nativeBuild.${platform} scheme that uploads to ${store}.`,
    );
    return only;
  }

  const reason = nonInteractiveReason();
  if (reason !== undefined) {
    return fail(
      `Several nativeBuild.${platform} schemes upload to ${store}: ${uploadable.join(", ")}. Hot Updater asks which one only at a terminal, never ${reason}: run npx hot-updater ${command} --scheme <${uploadable.join(" | ")}>.`,
    );
  }
  const picked = await p.select({
    message: `Which scheme do you upload to ${store}?`,
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
}: StoreUploadOptions): Promise<void> => {
  printBanner();
  const resolved = await resolveScheme(TESTFLIGHT, scheme);
  if (resolved === undefined) return;
  await buildIosNative({
    ...options,
    scheme: resolved,
    // The scheme is picked above: the build asks nothing more.
    interactive: false,
    upload: "testflight",
    register,
  });
};

/**
 * `google-play upload`: the shortcut for `build:android --scheme <scheme>
 * --upload play-internal --register`, with the same handler. It registers
 * the build unless `--no-register`, and without `--scheme` picks the scheme
 * that uploads to Google Play.
 */
export const handleGooglePlayUpload = async ({
  scheme,
  register = true,
  ...options
}: StoreUploadOptions): Promise<void> => {
  printBanner();
  const resolved = await resolveScheme(GOOGLE_PLAY, scheme);
  if (resolved === undefined) return;
  await buildAndroidNative({
    ...options,
    scheme: resolved,
    interactive: false,
    upload: "play-internal",
    register,
  });
};
