import { resolveTestFlightUploadKey } from "@hot-updater/apple-helper";
import type { ConfigResponse } from "@hot-updater/cli-tools";

import { IosConfigParser } from "../../utils/configParser/iosParser";
import type { NativeCheckIssue } from "./issues";

const COMPLIANCE_KEY = "ITSAppUsesNonExemptEncryption";

/**
 * Warns when a scheme can submit to TestFlight and `Info.plist` has no export
 * compliance key, so each build waits on an answer. Only the project's own
 * answer ends that, so this names the key and sets nothing. Before a prebuild
 * generates `ios/` there is nothing cheap to read: an `app.config.ts` would have
 * to run.
 */
export const checkTestFlightCompliance = async (
  config: ConfigResponse,
  cwd: string,
): Promise<NativeCheckIssue[]> => {
  const infoPlist = new IosConfigParser(config.platform.ios.infoPlistPaths);
  if (!(await infoPlist.exists())) return [];
  const { value, paths } = await infoPlist.get(COMPLIANCE_KEY);
  if (value !== null) return [];

  const schemes = (
    await Promise.all(
      Object.entries(config.nativeBuild?.ios ?? {}).map(
        async ([scheme, iosScheme]) =>
          iosScheme &&
          (await resolveTestFlightUploadKey({ scheme, iosScheme }).then(
            () => true,
            () => false,
          ))
            ? [scheme]
            : [],
      ),
    )
  ).flat();
  if (schemes.length === 0) return [];

  const adapter = await Promise.resolve(config.build({ cwd }))
    .then(({ name }) => name)
    .catch(() => undefined);
  const setting =
    adapter === "expo"
      ? "ios.config.usesNonExemptEncryption in the app config"
      : `${COMPLIANCE_KEY} in Info.plist`;
  return [
    {
      type: "warning",
      platform: "ios",
      code: "TESTFLIGHT_COMPLIANCE_UNSET",
      message: `TestFlight builds of ${schemes.join(", ")} wait on an export compliance answer: Info.plist has no ${COMPLIANCE_KEY}.`,
      resolution: `Set ${setting}, or answer each build in App Store Connect.`,
      paths,
    },
  ];
};
