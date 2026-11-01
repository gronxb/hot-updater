import {
  type AscDeviceOutcome,
  addAscDevices,
  listAscDevices,
} from "@hot-updater/apple-helper";
import {
  type Credentials,
  getCwd,
  loadConfig,
  p,
  parseSecretReference,
  readLoadedHotUpdaterEnv,
  withCredentialResolver,
} from "@hot-updater/cli-tools";
import { normalizeIosUdid } from "@hot-updater/protocol/native-artifact";

import { ui } from "../utils/cli-ui";
import { removeSavedAdHocProfileCommand } from "../utils/native/savedAdHocProfile";
import { printBanner } from "../utils/printBanner";

export interface NativeBuildDevicesOptions {
  /** The `nativeBuild.ios` scheme whose key to use; without it, the only one. */
  readonly scheme?: string;
}

export interface NativeBuildDevicesAddOptions extends NativeBuildDevicesOptions {
  readonly udid: readonly string[];
  /** One label for every UDID, or one for each, in order. */
  readonly name: readonly string[];
}

/**
 * The scheme whose App Store Connect API key speaks for the team: the named
 * one, or the only device scheme, since a page that shows a tester the command
 * can't know the project's scheme names.
 */
const pickScheme = async (scheme: string | undefined) => {
  const config = await loadConfig({ platform: "ios", channel: "" });
  const schemes = config.nativeBuild.ios;
  if (scheme !== undefined) {
    const iosScheme = schemes[scheme];
    if (iosScheme === undefined) {
      throw new Error(
        `hot-updater.config.ts has no nativeBuild.ios scheme ${scheme}.\nPick one: ${Object.keys(schemes).join(", ") || "(none)"}`,
      );
    }
    return { config, scheme, iosScheme };
  }
  const devices = Object.entries(schemes).filter(
    ([, iosScheme]) => !iosScheme.simulator,
  );
  const [only] = devices;
  if (only === undefined || devices.length > 1) {
    throw new Error(
      devices.length === 0
        ? "hot-updater.config.ts has no nativeBuild.ios scheme that builds for a device.\nAdd one with signing.ascApiKey."
        : `Several nativeBuild.ios schemes build for a device: ${devices.map(([name]) => name).join(", ")}.\nPick one with --scheme.`,
    );
  }
  return { config, scheme: only[0], iosScheme: only[1] };
};

/** Runs `run` with the scheme's App Store Connect API key, which it never issues. */
const withAscApiKey = async <T>(
  schemeName: string | undefined,
  run: (
    apiKey: Credentials["asc-api-key"],
    target: { readonly scheme: string; readonly bundleId: string },
  ) => Promise<T>,
): Promise<T> => {
  const { config, scheme, iosScheme } = await pickScheme(schemeName);
  const cwd = getCwd();
  return withCredentialResolver(
    async (credentials) =>
      run(
        await credentials.resolve({
          kind: "asc-api-key",
          name: iosScheme.signing
            ? parseSecretReference(
                iosScheme.signing.ascApiKey,
                "signing.ascApiKey",
              )
            : "asc-api-key",
        }),
        { scheme, bundleId: iosScheme.bundleIdentifier },
      ),
    {
      env: await readLoadedHotUpdaterEnv(cwd),
      secrets: config.secrets,
      cwd,
    },
  );
};

const fail = (error: unknown) => {
  p.log.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
};

/**
 * The devices to add, each UDID once, or a refusal before anything reaches
 * Apple: a typo would spend one of the account's yearly slots.
 */
const parseDevices = ({ udid, name }: NativeBuildDevicesAddOptions) => {
  if (name.length !== 1 && name.length !== udid.length) {
    throw new Error(
      `${udid.length} --udid and ${name.length} --name don't pair up.\nPass one --name for all of them, or one for each.`,
    );
  }
  const seen = new Set<string>();
  return udid.flatMap((value, index) => {
    const key = normalizeIosUdid(value);
    if (key === null) {
      throw new Error(
        `${value} isn't an iPhone's UDID.\nCopy it from the page "Check this iPhone" opens on the build's Console page.`,
      );
    }
    if (seen.has(key)) return [];
    seen.add(key);
    return [{ udid: value.trim(), name: name[index] ?? name[0]! }];
  });
};

const reportOutcome = (result: AscDeviceOutcome) => {
  switch (result.outcome) {
    case "registered":
      p.log.success(`Registered ${result.udid} as ${result.device.name}.`);
      return;
    case "already-registered":
      p.log.step(
        `${result.udid} is already registered as ${result.device.name}.`,
      );
      return;
    case "disabled":
      p.log.error(
        `${result.udid} is disabled in your Apple account, so no build can include it.\nEnable it at https://developer.apple.com/account/resources/devices/list`,
      );
      return;
    case "refused":
      p.log.error(
        result.limitReached
          ? `Apple refused ${result.udid}: ${result.reason}\nTestFlight has no such limit: npx hot-updater testflight`
          : `Apple refused ${result.udid}: ${result.reason}\nCheck the UDID, or the device list at https://developer.apple.com/account/resources/devices/list`,
      );
      return;
  }
};

/**
 * `native-build devices add`: registers iPhones with the Apple account of the
 * scheme's App Store Connect API key, and says the one thing left to do. App
 * Store Connect is the list of devices, so nothing else stores them. A registered
 * iPhone installs only an `.ipa` built after this.
 */
export const handleNativeBuildDevicesAdd = async (
  options: NativeBuildDevicesAddOptions,
) => {
  printBanner();
  try {
    const devices = parseDevices(options);
    const { outcomes, scheme, bundleId } = await withAscApiKey(
      options.scheme,
      async (apiKey, target) => ({
        outcomes: await addAscDevices({ devices, apiKey }),
        ...target,
      }),
    );
    outcomes.forEach(reportOutcome);
    const rebuildable = outcomes.filter(
      ({ outcome }) =>
        outcome === "registered" || outcome === "already-registered",
    );
    if (rebuildable.length > 0) {
      p.log.info(
        [
          ui.withCommand(
            "An existing .ipa never gains a device. Rebuild, with every iPhone you're adding:",
            `npx hot-updater native-build ios --scheme ${scheme} ${rebuildable.map(({ udid }) => `--udid ${udid}`).join(" ")}`,
          ),
          ui.withCommand(
            "A Mac or self-hosted runner reuses its saved profile, which can't gain a device either. Remove it there first:",
            removeSavedAdHocProfileCommand(bundleId),
          ),
        ].join("\n"),
      );
    }
    if (rebuildable.length !== outcomes.length) process.exitCode = 1;
  } catch (error) {
    fail(error);
  }
};

/** `native-build devices list`: what App Store Connect has, read each time. */
export const handleNativeBuildDevicesList = async (
  options: NativeBuildDevicesOptions,
) => {
  printBanner();
  try {
    const { devices, scheme } = await withAscApiKey(
      options.scheme,
      async (apiKey, { scheme }) => ({
        devices: await listAscDevices({ apiKey }),
        scheme,
      }),
    );
    if (devices.length === 0) {
      p.log.info(
        ui.withCommand(
          "This Apple account has no iPhones registered. Add one:",
          `npx hot-updater native-build devices add --scheme ${scheme} --udid <UDID> --name <name>`,
        ),
      );
      return;
    }
    p.log.message(
      ui.table(
        [
          { key: "name", label: "Name" },
          { key: "udid", label: "UDID" },
          { key: "kind", label: "Kind" },
          { key: "status", label: "Status" },
        ],
        devices.map(({ name, udid, deviceClass, status }) => ({
          name,
          udid,
          kind: deviceClass,
          status,
        })),
      ),
    );
  } catch (error) {
    fail(error);
  }
};
