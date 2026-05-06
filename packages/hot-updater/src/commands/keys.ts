import path from "node:path";

import { getCwd, loadConfig, p } from "@hot-updater/cli-tools";

import { AndroidConfigParser } from "@/utils/configParser/androidParser";
import { IosConfigParser } from "@/utils/configParser/iosParser";
import { warnIfExpoCNG } from "@/utils/expoDetection";
import { appendToProjectRootGitignore } from "@/utils/git";
import {
  generateKeyPair,
  getPublicKeyFromPrivate,
  loadPrivateKey,
  saveKeyPair,
} from "@/utils/signing";

import { ui } from "../utils/cli-ui";

export const ANDROID_KEY = "hot_updater_public_key";
export const IOS_KEY = "HOT_UPDATER_PUBLIC_KEY";

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

    // Add keys directory to .gitignore
    const keysDir = path.basename(outputDir);
    const gitignoreUpdated = appendToProjectRootGitignore({
      cwd,
      globLines: [`${keysDir}/`],
    });

    p.log.message(
      ui.block("Keys", [
        ui.kv("Private", ui.path(path.join(outputDir, "private-key.pem"))),
        ui.kv("Public", ui.path(path.join(outputDir, "public-key.pem"))),
        ui.kv("Gitignore", gitignoreUpdated ? `${keysDir}/` : "unchanged"),
      ]),
    );
    p.log.message(
      ui.block("Config", [
        ui.kv(
          "Code",
          ui.code(
            'signing: { enabled: true, privateKeyPath: "./keys/private-key.pem" }',
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
  customPaths: string[],
): Promise<WriteResult> {
  try {
    const androidParser = new AndroidConfigParser(customPaths);

    if (!(await androidParser.exists())) {
      return {
        platform: "android",
        paths: [],
        success: false,
        error: "No strings.xml files found",
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
  console.log('<string name="hot_updater_public_key">');
  console.log(publicKeyPEM.trim());
  console.log("</string>");
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
 * By default, writes the public key to iOS Info.plist and Android strings.xml.
 * Use --print-only to only display the key without modifying files.
 *
 * The private key path is read from hot-updater.config.ts (signing.privateKeyPath)
 * unless overridden with --input.
 *
 * Usage: npx hot-updater keys export-public [--input ./keys/private-key.pem] [--print-only] [--yes]
 */
export const keysExportPublic = async (
  options: KeysExportPublicOptions = {},
) => {
  warnIfExpoCNG();
  const cwd = getCwd();

  // Load config to get the private key path from signing.privateKeyPath
  const config = await loadConfig(null);
  const configPrivateKeyPath = config.signing?.privateKeyPath;

  // Priority: CLI --input > config signing.privateKeyPath > default fallback
  let privateKeyPath: string;
  if (options.input) {
    privateKeyPath = path.isAbsolute(options.input)
      ? options.input
      : path.join(cwd, options.input);
  } else if (configPrivateKeyPath) {
    privateKeyPath = path.isAbsolute(configPrivateKeyPath)
      ? configPrivateKeyPath
      : path.join(cwd, configPrivateKeyPath);
  } else {
    privateKeyPath = path.join(cwd, "keys", "private-key.pem");
  }

  try {
    const privateKeyPEM = await loadPrivateKey(privateKeyPath);
    const publicKeyPEM = getPublicKeyFromPrivate(privateKeyPEM);

    // PRINT-ONLY MODE: Show key and instructions without writing
    if (options.printOnly) {
      printPublicKeyInstructions(publicKeyPEM);
      return;
    }

    // Check which files exist (config already loaded above)
    const androidParser = new AndroidConfigParser(
      config.platform.android.stringResourcePaths,
    );
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
      p.log.message(
        formatNativeTarget(
          "android",
          config.platform.android.stringResourcePaths,
        ),
      );
    }
    if (iosExists) {
      p.log.message(
        formatNativeTarget("ios", config.platform.ios.infoPlistPaths),
      );
    }

    // Confirmation prompt (unless --yes)
    if (!options.yes) {
      const shouldContinue = await p.confirm({
        message: "Write public key?",
        initialValue: true,
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
          config.platform.android.stringResourcePaths,
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
  customPaths: string[],
): Promise<RemoveResult> {
  try {
    const androidParser = new AndroidConfigParser(customPaths);

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

  const androidParser = new AndroidConfigParser(
    config.platform.android.stringResourcePaths,
  );
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
    results.push(
      await removePublicKeyFromAndroid(
        config.platform.android.stringResourcePaths,
      ),
    );
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
