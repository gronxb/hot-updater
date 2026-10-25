import fs from "fs";
import path from "path";

import {
  type CredentialResolver,
  type Credentials,
  createCredentialResolver,
  parseVaultReference,
} from "@hot-updater/cli-tools";

import type { EnrichedNativeBuildIosScheme } from "./enrichNativeBuildIosScheme";

/**
 * How a device build signs with automatic signing, authenticated by the
 * scheme's App Store Connect API key: the xcodebuild arguments, and the key.
 * The key is resolved only here, for a device build of a scheme with
 * `signing`. Without `credentials`, it resolves from the environment or the
 * Console's vault, and the temporary files are deleted when the process
 * exits.
 */
export const resolveXcodeSigning = async ({
  schemeConfig,
  credentials,
}: {
  schemeConfig: EnrichedNativeBuildIosScheme;
  credentials?: Pick<CredentialResolver, "resolve">;
}): Promise<
  | {
      authenticationArgs: string[];
      apiKey: Credentials["asc-api-key"];
    }
  | undefined
> => {
  const reference = schemeConfig.signing?.ascApiKey;
  if (!reference) {
    return undefined;
  }

  const apiKey = await (credentials ?? createCredentialResolver()).resolve({
    kind: "asc-api-key",
    name: parseVaultReference(reference, "signing.ascApiKey"),
  });
  return {
    authenticationArgs: [
      "-allowProvisioningUpdates",
      "-authenticationKeyPath",
      apiKey.keyPath,
      "-authenticationKeyID",
      apiKey.keyId,
      "-authenticationKeyIssuerID",
      apiKey.issuerId,
    ],
    apiKey,
  };
};

/** The xcodebuild arguments of `resolveXcodeSigning`. */
export const resolveXcodeAuthenticationArgs = async (
  ...args: Parameters<typeof resolveXcodeSigning>
): Promise<string[] | undefined> =>
  (await resolveXcodeSigning(...args))?.authenticationArgs;

const APP_STORE_CONNECT_EXPORT_OPTIONS = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>method</key>
  <string>app-store-connect</string>
  <key>signingStyle</key>
  <string>automatic</string>
</dict>
</plist>
`;

/**
 * Writes the export options of a scheme that signs with an App Store Connect
 * API key and sets no `exportOptionsPlist`: an App Store Connect export with
 * automatic signing.
 */
export const writeAppStoreConnectExportOptions = async (directory: string) => {
  const exportOptionsPlist = path.join(directory, "ExportOptions.plist");
  await fs.promises.writeFile(
    exportOptionsPlist,
    APP_STORE_CONNECT_EXPORT_OPTIONS,
  );
  return exportOptionsPlist;
};
