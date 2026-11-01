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

/** The export option that keeps a build from App Store review. */
const INTERNAL_TESTING_ONLY = "testFlightInternalTestingOnly";

/**
 * Writes the export options of a scheme that signs with an App Store Connect
 * API key and sets no `exportOptionsPlist`: an App Store Connect export with
 * automatic signing, internal testing only for a sandbox build.
 */
export const writeAppStoreConnectExportOptions = async (
  directory: string,
  { internalTestingOnly = false }: { internalTestingOnly?: boolean } = {},
) => {
  const exportOptionsPlist = path.join(directory, "ExportOptions.plist");
  await fs.promises.writeFile(
    exportOptionsPlist,
    internalTestingOnly
      ? APP_STORE_CONNECT_EXPORT_OPTIONS.replace(
          "</dict>",
          `  <key>${INTERNAL_TESTING_ONLY}</key>\n  <true/>\n</dict>`,
        )
      : APP_STORE_CONNECT_EXPORT_OPTIONS,
  );
  return exportOptionsPlist;
};

/**
 * `testFlightInternalTestingOnly` in export options: undefined without it.
 */
const readInternalTestingOnly = async (
  exportOptionsPlist: string,
): Promise<boolean | undefined> => {
  const text = await fs.promises
    .readFile(exportOptionsPlist, "utf-8")
    .catch(() => undefined);
  const uncommented = text?.replace(/<!--[\s\S]*?-->/gu, "");
  if (uncommented?.includes("<plist")) {
    const match = new RegExp(
      `<key>\\s*${INTERNAL_TESTING_ONLY}\\s*</key>\\s*<(true|false)\\s*/>`,
      "u",
    ).exec(uncommented);
    return match ? match[1] === "true" : undefined;
  }
  const { stdout, exitCode } = await execa(
    "plutil",
    ["-extract", INTERNAL_TESTING_ONLY, "raw", "-o", "-", exportOptionsPlist],
    { reject: false },
  );
  return exitCode === 0 ? stdout.trim() === "true" : undefined;
};

/**
 * Refuses a sandbox scheme's App Store Connect export that turns internal
 * testing off: Apple keeps a build out of review only with it on. Another
 * method's `.ipa` never reaches App Store Connect.
 */
export const assertSandboxExportOptions = async (
  schemeName: string,
  exportOptionsPlist: string,
): Promise<void> => {
  if (
    APP_STORE_EXPORT_METHODS.has(await readExportMethod(exportOptionsPlist)) &&
    (await readInternalTestingOnly(exportOptionsPlist)) === false
  ) {
    throw new Error(
      `The sandbox scheme ${schemeName} turns ${INTERNAL_TESTING_ONLY} off in exportOptionsPlist.\nRemove the key, or set it to true.`,
    );
  }
};

/**
 * The export options a sandbox scheme's `exportOptionsPlist` exports with:
 * the file itself, or a copy in `directory` that turns internal testing on
 * when an App Store Connect export leaves it out.
 */
export const resolveSandboxExportOptions = async (
  schemeName: string,
  exportOptionsPlist: string,
  directory: string,
): Promise<string> => {
  await assertSandboxExportOptions(schemeName, exportOptionsPlist);
  if (
    !APP_STORE_EXPORT_METHODS.has(await readExportMethod(exportOptionsPlist)) ||
    (await readInternalTestingOnly(exportOptionsPlist)) === true
  ) {
    return exportOptionsPlist;
  }
  const copy = path.join(directory, "ExportOptions.plist");
  await fs.promises.copyFile(exportOptionsPlist, copy);
  await execa("plutil", [
    "-insert",
    INTERNAL_TESTING_ONLY,
    "-bool",
    "true",
    copy,
  ]);
  return copy;
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
  // Comments go first: a commented-out method is no method.
  const xml = text
    ?.replace(/<!--[\s\S]*?-->/gu, "")
    .match(/<key>\s*method\s*<\/key>\s*<string>\s*([^<]*?)\s*<\/string>/u);
  if (xml) return xml[1]!;
  const { stdout, exitCode } = await execa(
    "plutil",
    ["-extract", "method", "raw", "-o", "-", exportOptionsPlist],
    { reject: false },
  );
  return exitCode === 0 ? stdout.trim() : "";
};

/**
 * Whether a device build exports for the devices its profile lists: with
 * `release-testing`, or `ad-hoc`, Xcode's older name for it. On an empty
 * keychain with the API key, Apple's cloud-managed distribution certificate
 * signs it, as it does an App Store Connect export.
 */
export const exportsForRegisteredDevices = async ({
  exportOptionsPlist,
}: EnrichedNativeBuildIosScheme): Promise<boolean> =>
  exportOptionsPlist !== undefined &&
  ["release-testing", "ad-hoc"].includes(
    await readExportMethod(exportOptionsPlist),
  );

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
