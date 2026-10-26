import fs from "fs";
import path from "path";

import {
  type CredentialResolver,
  type Credentials,
  createCredentialResolver,
  parseSecretReference,
} from "@hot-updater/cli-tools";
import { execa } from "execa";

import type { EnrichedNativeBuildIosScheme } from "./enrichNativeBuildIosScheme";

/**
 * How a device build signs with automatic signing, authenticated by the
 * scheme's App Store Connect API key: the xcodebuild arguments, and the key.
 * The key is resolved only here, for a device build of a scheme with
 * `signing`. Without `credentials`, it resolves from the environment or the
 * config's `secrets` adapter, and the temporary files are deleted when the
 * process exits.
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
    name: parseSecretReference(reference, "signing.ascApiKey"),
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

/** The export methods whose `.ipa` App Store Connect takes. */
export const APP_STORE_EXPORT_METHODS = new Set([
  "app-store",
  "app-store-connect",
]);

/** The `method` of export options, or "" when it has none or can't be read. */
export const readExportMethod = async (exportOptionsPlist: string) => {
  // An XML plist is read as text, on any platform; a binary one needs plutil.
  const text = await fs.promises
    .readFile(exportOptionsPlist, "utf-8")
    .catch(() => undefined);
  const xml = text?.match(
    /<key>\s*method\s*<\/key>\s*<string>\s*([^<]*?)\s*<\/string>/u,
  );
  if (xml) return xml[1]!;
  const { stdout, exitCode } = await execa(
    "plutil",
    ["-extract", "method", "raw", "-o", "-", exportOptionsPlist],
    { reject: false },
  );
  return exitCode === 0 ? stdout.trim() : "";
};

/**
 * Whether a device build exports for App Store Connect: with its
 * `exportOptionsPlist`'s method, or, without one, as a scheme signing with
 * an App Store Connect API key does. Such an `.ipa` is signed with Apple's
 * cloud-managed distribution certificate, never with a development
 * certificate the archive was signed with.
 */
export const exportsForAppStoreConnect = async (
  schemeConfig: EnrichedNativeBuildIosScheme,
): Promise<boolean> =>
  !schemeConfig.exportOptionsPlist ||
  APP_STORE_EXPORT_METHODS.has(
    await readExportMethod(schemeConfig.exportOptionsPlist),
  );
