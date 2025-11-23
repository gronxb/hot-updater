import path from "node:path";
import { colors, getCwd, loadConfig, p } from "@hot-updater/cli-tools";
import { AndroidConfigParser } from "@/utils/configParser/androidParser";
import { IosConfigParser } from "@/utils/configParser/iosParser";
import {
  generateKeyPair,
  getPublicKeyFromPrivate,
  loadPrivateKey,
  saveKeyPair,
} from "@/utils/signing";

const ANDROID_KEY = "hot_updater_public_key";
const IOS_KEY = "HOT_UPDATER_PUBLIC_KEY";

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

  p.log.info(`Generating ${keySize}-bit RSA key pair...`);

  const spinner = p.spinner();
  spinner.start("Generating keys");

  try {
    const keyPair = await generateKeyPair(keySize);
    await saveKeyPair(keyPair, outputDir);

    spinner.stop("Keys generated successfully");

    p.log.success(`Private key: ${path.join(outputDir, "private-key.pem")}`);
    p.log.success(`Public key: ${path.join(outputDir, "public-key.pem")}`);
    console.log("");
    p.log.warn("⚠️  Keep private key secure!");
    p.log.warn("   - Add keys/ to .gitignore");
    p.log.warn("   - Use secure storage for CI/CD (AWS Secrets Manager, etc.)");
    console.log("");
    p.log.info("Next steps:");
    p.log.info("1. Add to hot-updater.config.ts:");
    p.log.info(
      '   signing: { enabled: true, privateKeyPath: "./keys/private-key.pem" }',
    );
    p.log.info("2. Run: npx hot-updater keys:export-public");
    p.log.info("3. Embed public key in iOS Info.plist and Android strings.xml");
    p.log.info("4. Rebuild native app");
  } catch (error) {
    spinner.stop("Failed to generate keys", 1);
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
  console.log(
    colors.cyan("═══════════════════════════════════════════════════════"),
  );
  console.log(colors.cyan("Public Key (embed in native configuration)"));
  console.log(
    colors.cyan("═══════════════════════════════════════════════════════"),
  );
  console.log("");
  console.log(publicKeyPEM);
  console.log("");
  console.log(colors.yellow("iOS Configuration (Info.plist):"));
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("<key>HOT_UPDATER_PUBLIC_KEY</key>");
  console.log(`<string>${publicKeyPEM.trim().replace(/\n/g, "\\n")}</string>`);
  console.log("");
  console.log(colors.yellow("Android Configuration (res/values/strings.xml):"));
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log('<string name="hot_updater_public_key">');
  console.log(publicKeyPEM.trim());
  console.log("</string>");
  console.log("");
  console.log(
    colors.cyan("═══════════════════════════════════════════════════════"),
  );
}

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

    // WRITE MODE (default): Write to native files
    p.log.info(
      "Preparing to write public key to native configuration files...",
    );

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

    // Show preview of what will be updated
    console.log("");
    p.log.step("Files to be updated:");
    if (androidExists) {
      p.log.info(`  Android: strings.xml (${ANDROID_KEY})`);
    }
    if (iosExists) {
      p.log.info(`  iOS: Info.plist (${IOS_KEY})`);
    }
    console.log("");

    // Confirmation prompt (unless --yes)
    if (!options.yes) {
      const shouldContinue = await p.confirm({
        message: "Write public key to native files?",
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

    // Report results
    console.log("");
    for (const result of results) {
      if (result.success) {
        p.log.success(`${result.platform}: Updated ${result.paths.join(", ")}`);
      } else {
        p.log.error(`${result.platform}: ${result.error}`);
      }
    }

    // Summary
    const successCount = results.filter((r) => r.success).length;
    console.log("");
    if (successCount === results.length) {
      p.log.success("Public key written to all native files!");
      p.log.info("Next step: Rebuild your native app to apply the changes.");
    } else if (successCount > 0) {
      p.log.warn("Public key written to some files. Check errors above.");
    } else {
      p.log.error("Failed to write public key to any native files.");
      process.exit(1);
    }
  } catch (error) {
    p.log.error(`Failed to export public key: ${(error as Error).message}`);
    process.exit(1);
  }
};
