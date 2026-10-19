import fs from "fs";
import path from "path";

import {
  type CredentialResolver,
  createCredentialResolver,
} from "@hot-updater/cli-tools";

import type { EnrichedNativeBuildIosScheme } from "./enrichNativeBuildIosScheme";

/**
 * The xcodebuild arguments that sign with automatic signing, authenticated by
 * the scheme's App Store Connect API key. The key is resolved only here, for
 * a device build of a scheme with `signing`. Without `credentials`, it
 * resolves from the environment, and the temporary files are deleted when
 * the process exits.
 */
export const resolveXcodeAuthenticationArgs = async ({
  schemeConfig,
  credentials,
}: {
  schemeConfig: EnrichedNativeBuildIosScheme;
  credentials?: Pick<CredentialResolver, "resolve">;
}): Promise<string[] | undefined> => {
  const name = schemeConfig.signing?.ascApiKey;
  if (!name) {
    return undefined;
  }

  const key = await (credentials ?? createCredentialResolver()).resolve({
    kind: "asc-api-key",
    name,
  });
  return [
    "-allowProvisioningUpdates",
    "-authenticationKeyPath",
    key.keyPath,
    "-authenticationKeyID",
    key.keyId,
    "-authenticationKeyIssuerID",
    key.issuerId,
  ];
};

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
