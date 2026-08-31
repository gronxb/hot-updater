import { createHash, createPublicKey } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import {
  getBundleSigningPublicKey,
  getCwd,
  loadConfig,
  p,
} from "@hot-updater/cli-tools";

import { AndroidConfigParser } from "@/utils/configParser/androidParser";
import { IosConfigParser } from "@/utils/configParser/iosParser";
import { warnIfExpoCNG } from "@/utils/expoDetection";
import { appendToProjectRootGitignore } from "@/utils/git";
import {
  generateKeyPair,
  getPrivateKeyGitignorePath,
  getPublicKeyFromPrivate,
  loadPrivateKey,
  saveKeyPair,
} from "@/utils/signing";

import { ui } from "../utils/cli-ui";

export const ANDROID_KEY = "hot_updater_public_key";
export const IOS_KEY = "HOT_UPDATER_PUBLIC_KEY";

const canonicalizeRsaSpkiPublicKey = (publicKeyPem: string): string => {
  const trimmed = publicKeyPem.replaceAll("\\n", "\n").trim();
  if (
    !trimmed.startsWith("-----BEGIN PUBLIC KEY-----") ||
    !trimmed.endsWith("-----END PUBLIC KEY-----") ||
    trimmed.includes("PRIVATE KEY")
  ) {
    throw new Error("Bundle signing public key must be an SPKI PEM key.");
  }

  const publicKey = createPublicKey(trimmed);
  if (
    publicKey.asymmetricKeyType !== "rsa" ||
    (publicKey.asymmetricKeyDetails?.modulusLength ?? 0) < 2048
  ) {
    throw new Error("Bundle signing public key must be an RSA key.");
  }

  return publicKey.export({ format: "pem", type: "spki" }).toString();
};

const getPublicKeyIdentity = (publicKeyPem: string) => {
  const publicKey = createPublicKey(canonicalizeRsaSpkiPublicKey(publicKeyPem));
  const der = publicKey.export({ format: "der", type: "spki" });
  return {
    der,
    fingerprint: `sha256:${createHash("sha256").update(der).digest("hex")}`,
  };
};

const getTrustAnchorChange = (
  platform: "android" | "ios",
  existingPublicKey: string | null,
  nextPublicKey: ReturnType<typeof getPublicKeyIdentity>,
) => {
  if (!existingPublicKey) return null;

  try {
    const existing = getPublicKeyIdentity(existingPublicKey);
    if (existing.der.equals(nextPublicKey.der)) return null;
    return { platform, fingerprint: existing.fingerprint };
  } catch {
    return { platform, fingerprint: "invalid public key" };
  }
};

export interface KeysGenerateOptions {
  output?: string;
  keySize?: 2048 | 4096;
}

/**
 * Generate RSA key pair for code signing.
 * Usage: npx hot-updater keys:generate [--output ./keys] [--key-size 4096]
 */
export const keysGenerate = async (options: KeysGenerateOptions = {}) => {
  const cwd = getCwd();
  const outputDir = options.output
    ? path.isAbsolute(options.output)
      ? options.output
      : path.join(cwd, options.output)
    : path.join(cwd, "keys");

  const keySize = options.keySize ?? 4096;

  const spinner = p.spinner();
  spinner.start(`Generating ${keySize}-bit RSA keys`);

  try {
    const keyPair = await generateKeyPair(keySize);
    await saveKeyPair(keyPair, outputDir);

    spinner.stop("Keys generated");

    // The public key is safe to commit and is required by native builds.
    const privateKeyGitignorePath = getPrivateKeyGitignorePath(cwd, outputDir);
    const gitignoreUpdated = privateKeyGitignorePath
      ? appendToProjectRootGitignore({
          cwd,
          globLines: [privateKeyGitignorePath],
        })
      : false;

    p.log.message(
      ui.block("Keys", [
        ui.kv("Private", ui.path(path.join(outputDir, "private-key.pem"))),
        ui.kv("Public", ui.path(path.join(outputDir, "public-key.pem"))),
        ui.kv(
          "Gitignore",
          privateKeyGitignorePath === null
            ? "outside project"
            : gitignoreUpdated
              ? privateKeyGitignorePath
              : "unchanged",
        ),
      ]),
    );
    p.log.message(
      ui.block("Config", [
        ui.kv(
          "Code",
          ui.code(
            'signing: {\n  enabled: true,\n  privateKeyPath: "./keys/private-key.pem",\n}',
          ),
        ),
        ui.kv("Run", ui.command("hot-updater keys export-public")),
      ]),
    );
    p.log.warn("Keep private key secure.");
  } catch (error) {
    spinner.error("Failed to generate keys");
    p.log.error((error as Error).message);
    process.exit(1);
  }
};

export interface KeysExportPublicOptions {
  input?: string;
  output?: string;
  printOnly?: boolean;
  yes?: boolean;
}

interface WriteResult {
  platform: "android" | "ios";
  paths: string[];
  success: boolean;
  error?: string;
}

async function writePublicKeyToAndroid(
  publicKey: string,
  androidManifestPaths: string[],
): Promise<WriteResult> {
  try {
    const androidParser = new AndroidConfigParser(androidManifestPaths);

    if (!(await androidParser.exists())) {
      return {
        platform: "android",
        paths: [],
        success: false,
        error: "No Android native config files found",
      };
    }

    const result = await androidParser.set(ANDROID_KEY, publicKey);
    return { platform: "android", paths: result.paths, success: true };
  } catch (error) {
    return {
      platform: "android",
      paths: [],
      success: false,
      error: (error as Error).message,
    };
  }
}

async function writePublicKeyToIos(
  publicKey: string,
  customPaths: string[],
): Promise<WriteResult> {
  try {
    const iosParser = new IosConfigParser(customPaths);

    if (!(await iosParser.exists())) {
      return {
        platform: "ios",
        paths: [],
        success: false,
        error: "No Info.plist files found",
      };
    }

    const result = await iosParser.set(IOS_KEY, publicKey);
    return { platform: "ios", paths: result.paths, success: true };
  } catch (error) {
    return {
      platform: "ios",
      paths: [],
      success: false,
      error: (error as Error).message,
    };
  }
}

function printPublicKeyInstructions(publicKeyPEM: string): void {
  console.log("");
  console.log(ui.title("Public key"));
  console.log("");
  console.log(publicKeyPEM);
  console.log("");
  console.log(ui.title("iOS"));
  console.log("<key>HOT_UPDATER_PUBLIC_KEY</key>");
  console.log(`<string>${publicKeyPEM.trim().replace(/\n/g, "\\n")}</string>`);
  console.log("");
  console.log(ui.title("Android"));
  console.log('<meta-data android:name="com.hotupdater.PUBLIC_KEY"');
  console.log(
    `  android:value="${publicKeyPEM.trim().replace(/\n/g, "\\n")}" />`,
  );
}

const formatNativeTarget = (
  platform: "android" | "ios",
  paths: string[],
): string =>
  ui.block(
    platform,
    paths.map((targetPath) => ui.kv("Path", ui.path(targetPath))),
  );

/**
 * Export public key for embedding in native configuration.
 * By default, writes the public key to iOS Info.plist and AndroidManifest.xml.
 * Use --output to write an Expo trust-anchor file, or --print-only to display
 * the key without modifying files.
 *
 * The public key is read from the configured signing source unless --input
 * provides a private key path explicitly.
 *
 * Usage: npx hot-updater keys export-public [--input ./keys/private-key.pem] [--output ./keys/public-key.pem] [--print-only] [--yes]
 */
export const keysExportPublic = async (
  options: KeysExportPublicOptions = {},
) => {
  const cwd = getCwd();

  const config = await loadConfig(null);
  try {
    let publicKeyPEM: string;
    if (options.input) {
      const privateKeyPath = path.isAbsolute(options.input)
        ? options.input
        : path.join(cwd, options.input);
      publicKeyPEM = getPublicKeyFromPrivate(
        await loadPrivateKey(privateKeyPath),
      );
    } else if (config.signing) {
      publicKeyPEM = (await getBundleSigningPublicKey(config.signing, {
        cwd,
      }))!;
    } else {
      throw new Error(
        "Bundle signing is not configured. Pass --input or configure signing first.",
      );
    }

    if (options.output && options.printOnly) {
      throw new Error("--output and --print-only cannot be combined.");
    }

    if (options.output) {
      const outputPath = path.isAbsolute(options.output)
        ? options.output
        : path.join(cwd, options.output);
      await fs.mkdir(path.dirname(outputPath), { recursive: true });
      await fs.writeFile(
        outputPath,
        canonicalizeRsaSpkiPublicKey(publicKeyPEM),
        { flag: "wx", mode: 0o644 },
      );
      p.log.success(ui.line(["Public key", ui.path(outputPath)]));
      return;
    }

    // PRINT-ONLY MODE: Show key and instructions without writing
    if (options.printOnly) {
      printPublicKeyInstructions(publicKeyPEM);
      return;
    }

    warnIfExpoCNG();

    const androidManifestPaths =
      config.platform.android.androidManifestPaths ?? [];

    // Check which files exist (config already loaded above)
    const androidParser = new AndroidConfigParser(androidManifestPaths);
    const iosParser = new IosConfigParser(config.platform.ios.infoPlistPaths);

    const androidExists = await androidParser.exists();
    const iosExists = await iosParser.exists();

    if (!androidExists && !iosExists) {
      p.log.error("No native configuration files found.");
      p.log.info(
        "Tip: Use --print-only to display the key for manual configuration.",
      );
      process.exit(1);
    }

    p.log.message(ui.title("Native files"));
    if (androidExists) {
      p.log.message(formatNativeTarget("android", androidManifestPaths));
    }
    if (iosExists) {
      p.log.message(
        formatNativeTarget("ios", config.platform.ios.infoPlistPaths),
      );
    }

    const [androidPublicKey, iosPublicKey] = await Promise.all([
      androidExists
        ? androidParser.get(ANDROID_KEY)
        : Promise.resolve({ value: null }),
      iosExists ? iosParser.get(IOS_KEY) : Promise.resolve({ value: null }),
    ]);
    const nextPublicKey = getPublicKeyIdentity(publicKeyPEM);
    const trustAnchorChanges = [
      getTrustAnchorChange("android", androidPublicKey.value, nextPublicKey),
      getTrustAnchorChange("ios", iosPublicKey.value, nextPublicKey),
    ].filter((change) => change !== null);

    if (trustAnchorChanges.length > 0) {
      p.log.warn(
        "Replacing a native bundle signing key is not a transparent rotation.",
      );
      p.log.message(
        ui.block("Trust anchor change", [
          ui.kv("New", nextPublicKey.fingerprint),
          ...trustAnchorChanges.map(({ platform, fingerprint }) =>
            ui.kv(platform, fingerprint),
          ),
        ]),
      );
      p.log.warn(
        "Installed apps using the previous key will reject bundles signed by the new key.",
      );
    }

    // Confirmation prompt (unless --yes)
    if (!options.yes) {
      const shouldContinue = await p.confirm({
        message:
          trustAnchorChanges.length > 0
            ? "Replace the existing public key?"
            : "Write public key?",
        initialValue: trustAnchorChanges.length === 0,
      });

      if (p.isCancel(shouldContinue) || !shouldContinue) {
        p.cancel("Operation cancelled");
        process.exit(0);
      }
    }

    // Perform writes
    const results: WriteResult[] = [];

    if (androidExists) {
      results.push(
        await writePublicKeyToAndroid(
          publicKeyPEM.trim(),
          androidManifestPaths,
        ),
      );
    }
    if (iosExists) {
      results.push(
        await writePublicKeyToIos(
          publicKeyPEM.trim(),
          config.platform.ios.infoPlistPaths,
        ),
      );
    }

    for (const result of results) {
      if (result.success) {
        p.log.success(
          ui.line([
            ui.platform(result.platform),
            `${result.paths.length} file(s) updated`,
          ]),
        );
      } else {
        p.log.error(`${result.platform}: ${result.error}`);
      }
    }

    // Summary
    const successCount = results.filter((r) => r.success).length;
    if (successCount === results.length) {
      p.log.success("Public key exported.");
    } else if (successCount > 0) {
      p.log.warn("Public key exported partially.");
    } else {
      p.log.error("Public key export failed.");
      process.exit(1);
    }
  } catch (error) {
    p.log.error(`Failed to export public key: ${(error as Error).message}`);
    process.exit(1);
  }
};

export interface KeysRemoveOptions {
  yes?: boolean;
}

interface RemoveResult {
  platform: "android" | "ios";
  paths: string[];
  success: boolean;
  found: boolean;
  error?: string;
}

async function removePublicKeyFromAndroid(
  androidManifestPaths: string[],
): Promise<RemoveResult> {
  try {
    const androidParser = new AndroidConfigParser(androidManifestPaths);

    if (!(await androidParser.exists())) {
      return {
        platform: "android",
        paths: [],
        success: true,
        found: false,
      };
    }

    // Check if key exists
    const existing = await androidParser.get(ANDROID_KEY);
    if (!existing.value) {
      return {
        platform: "android",
        paths: existing.paths,
        success: true,
        found: false,
      };
    }

    const result = await androidParser.remove(ANDROID_KEY);
    return {
      platform: "android",
      paths: result.paths,
      success: true,
      found: true,
    };
  } catch (error) {
    return {
      platform: "android",
      paths: [],
      success: false,
      found: true,
      error: (error as Error).message,
    };
  }
}

async function removePublicKeyFromIos(
  customPaths: string[],
): Promise<RemoveResult> {
  try {
    const iosParser = new IosConfigParser(customPaths);

    if (!(await iosParser.exists())) {
      return {
        platform: "ios",
        paths: [],
        success: true,
        found: false,
      };
    }

    // Check if key exists
    const existing = await iosParser.get(IOS_KEY);
    if (!existing.value) {
      return {
        platform: "ios",
        paths: existing.paths,
        success: true,
        found: false,
      };
    }

    const result = await iosParser.remove(IOS_KEY);
    return {
      platform: "ios",
      paths: result.paths,
      success: true,
      found: true,
    };
  } catch (error) {
    return {
      platform: "ios",
      paths: [],
      success: false,
      found: true,
      error: (error as Error).message,
    };
  }
}

/**
 * Remove public keys from native configuration files.
 * Automatically detects and removes keys from both iOS and Android.
 *
 * Usage: npx hot-updater keys remove [--yes]
 */
export const keysRemove = async (options: KeysRemoveOptions = {}) => {
  const config = await loadConfig(null);
  const androidManifestPaths =
    config.platform.android.androidManifestPaths ?? [];

  const androidParser = new AndroidConfigParser(androidManifestPaths);
  const iosParser = new IosConfigParser(config.platform.ios.infoPlistPaths);

  // Check what exists
  const [androidExists, iosExists] = await Promise.all([
    androidParser.exists(),
    iosParser.exists(),
  ]);

  if (!androidExists && !iosExists) {
    p.log.info("No native configuration files found.");
    return;
  }

  // Check for existing keys
  const [androidKey, iosKey] = await Promise.all([
    androidExists
      ? androidParser.get(ANDROID_KEY)
      : Promise.resolve({ value: null, paths: [] }),
    iosExists
      ? iosParser.get(IOS_KEY)
      : Promise.resolve({ value: null, paths: [] }),
  ]);

  const foundKeys: string[] = [];
  if (iosKey.value) {
    foundKeys.push(
      ui.kv(
        "iOS",
        iosKey.paths.map((targetPath) => ui.path(targetPath)).join(", "),
      ),
    );
  }
  if (androidKey.value) {
    foundKeys.push(
      ui.kv(
        "Android",
        androidKey.paths.map((targetPath) => ui.path(targetPath)).join(", "),
      ),
    );
  }

  if (foundKeys.length === 0) {
    p.log.info("No public keys found in native files.");
    return;
  }

  p.log.message(ui.block("Public keys", foundKeys));

  // Confirmation prompt (unless --yes)
  if (!options.yes) {
    const shouldContinue = await p.confirm({
      message: "Remove public keys from these files?",
      initialValue: false,
    });

    if (p.isCancel(shouldContinue) || !shouldContinue) {
      p.cancel("Operation cancelled");
      return;
    }
  }

  // Perform removal
  const results: RemoveResult[] = [];

  if (iosKey.value) {
    results.push(
      await removePublicKeyFromIos(config.platform.ios.infoPlistPaths),
    );
  }
  if (androidKey.value) {
    results.push(await removePublicKeyFromAndroid(androidManifestPaths));
  }

  for (const result of results) {
    if (result.success && result.found) {
      p.log.success(
        ui.line([
          "Removed",
          ui.platform(result.platform),
          ui.path(result.paths.join(", ")),
        ]),
      );
    } else if (!result.success) {
      p.log.error(`${result.platform}: ${result.error}`);
    }
  }

  // Summary
  const successCount = results.filter((r) => r.success && r.found).length;
  if (successCount > 0) {
    p.log.success("Public keys removed.");
  }
};
