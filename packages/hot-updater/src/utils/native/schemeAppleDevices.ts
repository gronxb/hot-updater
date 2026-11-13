import path from "path";

import {
  type EnrichedNativeBuildIosScheme,
  exportsForRegisteredDevices,
  listAscDevices,
} from "@hot-updater/apple-helper";
import {
  getCwd,
  type loadConfig,
  readLoadedHotUpdaterEnv,
  withCredentialResolver,
} from "@hot-updater/cli-tools";

import type { AppleDeviceState } from "./iosDeviceCoverage";
import {
  ascDevicesByUdid,
  manualSigning,
  resolveSchemeAscApiKey,
} from "./registerApprovedDevices";

/**
 * Apple's devices in the account an `nativeBuild.ios` scheme signs with, read
 * as its next ad hoc build reads them, writing nothing: or why that build
 * couldn't add a device, as it would say.
 */
export const readSchemeAppleDevices = async (
  config: Awaited<ReturnType<typeof loadConfig>>,
  scheme: string,
): Promise<AppleDeviceState> => {
  const iosScheme = config.nativeBuild.ios[scheme];
  const ascApiKey = iosScheme?.signing?.ascApiKey;
  if (iosScheme === undefined || ascApiKey === undefined) {
    return {
      kind: "unavailable",
      reason: "the scheme signs without signing.ascApiKey",
    };
  }
  const cwd = getCwd();
  const exportOptionsPlist =
    iosScheme.exportOptionsPlist === undefined
      ? undefined
      : path.resolve(cwd, iosScheme.exportOptionsPlist);
  // The build's own gate: it runs the device registry's step only for an
  // export that lists registered devices, so no other build adds one.
  if (
    !(await exportsForRegisteredDevices({
      exportOptionsPlist,
    } as EnrichedNativeBuildIosScheme))
  ) {
    return {
      kind: "unavailable",
      reason: "the scheme doesn't export with release-testing",
    };
  }
  if (await manualSigning(exportOptionsPlist)) {
    return {
      kind: "unavailable",
      reason: "the scheme pins a provisioning profile",
    };
  }
  return withCredentialResolver(
    async (credentials): Promise<AppleDeviceState> => {
      const apiKey = await resolveSchemeAscApiKey(credentials, ascApiKey);
      return {
        kind: "read",
        issuerId: apiKey.issuerId,
        devices: ascDevicesByUdid(await listAscDevices({ apiKey })),
      };
    },
    { env: await readLoadedHotUpdaterEnv(cwd), secrets: config.secrets, cwd },
  );
};
