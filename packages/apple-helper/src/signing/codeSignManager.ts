import { execa } from "execa";
import * as p from "@clack/prompts";

/**
 * Signing identity information
 */
export interface SigningIdentity {
  /** Certificate hash/fingerprint */
  hash: string;
  /** Certificate name/display name */
  name: string;
}

/**
 * Code signing options
 */
export interface CodeSignOptions {
  /** Path to the app bundle to sign */
  appPath: string;
  /** Signing identity name or hash */
  identity: string;
  /** Path to entitlements file */
  entitlementsPath?: string;
  /** Additional codesign arguments */
  extraArgs?: string[];
  /** Force re-signing */
  force?: boolean;
}

/**
 * Code signing manager for iOS applications
 */
export class CodeSignManager {
  /**
   * Gets valid code signing identities from macOS Keychain
   * @returns Array of available signing identities
   * 
   * @example
   * ```typescript
   * const manager = new CodeSignManager();
   * const identities = await manager.getValidSigningIdentities();
   * console.log(identities); // [{ hash: "ABC123...", name: "Apple Development: ..." }]
   * ```
   */
  async getValidSigningIdentities(): Promise<SigningIdentity[]> {
    try {
      const { stdout } = await execa("security", [
        "find-identity",
        "-v",
        "-p",
        "codesigning",
      ]);

      return this.parseSigningIdentities(stdout);
    } catch (error) {
      throw new Error(`Failed to load signing identities: ${error}`);
    }
  }

  /**
   * Prompts user to select a signing identity interactively
   * @param currentIdentity - Current identity to highlight in the list
   * @returns Selected signing identity name
   * 
   * @example
   * ```typescript
   * const manager = new CodeSignManager();
   * const selected = await manager.promptSigningIdentity();
   * console.log(selected); // "Apple Development: John Doe (TEAMID)"
   * ```
   */
  async promptSigningIdentity(currentIdentity?: string): Promise<string | undefined> {
    const identities = await this.getValidSigningIdentities();

    if (identities.length === 0) {
      p.log.error("No valid code signing identities found in Keychain");
      return undefined;
    }

    if (identities.length === 1) {
      p.log.info(`Using signing identity: ${identities[0].name}`);
      return identities[0].name;
    }

    const current = currentIdentity
      ? identities.find((i) => i.name === currentIdentity)
      : undefined;
    const other = identities.filter((i) => i.name !== currentIdentity);
    const list = current ? [current, ...other] : other;

    const selected = await p.select({
      message: "Select a signing identity:",
      options: list.map((identity) => ({
        label: identity.name,
        value: identity.name,
        hint: identity.name === currentIdentity ? "Current" : undefined,
      })),
    });

    return p.isCancel(selected) ? undefined : selected;
  }

  /**
   * Signs an iOS app bundle with specified identity
   * @param options - Code signing options
   * 
   * @example
   * ```typescript
   * const manager = new CodeSignManager();
   * await manager.signApp({
   *   appPath: "/path/to/MyApp.app",
   *   identity: "Apple Development: John Doe (TEAMID)",
   *   entitlementsPath: "/path/to/entitlements.plist",
   *   force: true
   * });
   * ```
   */
  async signApp(options: CodeSignOptions): Promise<void> {
    const spinner = p.spinner();
    spinner.start(`Signing app with identity: ${options.identity}`);

    try {
      const codesignArgs = [
        "--sign",
        options.identity,
        "--verbose",
      ];

      if (options.force) {
        codesignArgs.push("--force");
      }

      if (options.entitlementsPath) {
        codesignArgs.push("--entitlements", options.entitlementsPath);
      }

      if (options.extraArgs) {
        codesignArgs.push(...options.extraArgs);
      }

      codesignArgs.push(options.appPath);

      await execa("codesign", codesignArgs);
      spinner.stop("Successfully signed app");
    } catch (error) {
      spinner.stop("Failed to sign app");
      throw new Error(`Code signing failed: ${error}`);
    }
  }

  /**
   * Verifies code signature of an app bundle
   * @param appPath - Path to the app bundle
   * @param verbose - Enable verbose verification output
   * @returns True if signature is valid
   * 
   * @example
   * ```typescript
   * const manager = new CodeSignManager();
   * const isValid = await manager.verifySignature("/path/to/MyApp.app");
   * console.log(isValid); // true or false
   * ```
   */
  async verifySignature(appPath: string, verbose: boolean = false): Promise<boolean> {
    try {
      const verifyArgs = ["--verify"];
      
      if (verbose) {
        verifyArgs.push("--verbose");
      }
      
      verifyArgs.push(appPath);

      await execa("codesign", verifyArgs);
      return true;
    } catch (error) {
      p.log.warn(`Signature verification failed: ${error}`);
      return false;
    }
  }

  /**
   * Gets signing information for an app bundle
   * @param appPath - Path to the app bundle
   * @returns Signing information or null if not signed
   * 
   * @example
   * ```typescript
   * const manager = new CodeSignManager();
   * const info = await manager.getSigningInfo("/path/to/MyApp.app");
   * console.log(info?.identity); // "Apple Development: John Doe (TEAMID)"
   * ```
   */
  async getSigningInfo(appPath: string): Promise<{ identity?: string; teamId?: string } | null> {
    try {
      const { stdout } = await execa("codesign", [
        "--display",
        "--verbose=2",
        appPath,
      ]);

      // Parse signing information from output
      const identityMatch = stdout.match(/Authority=(.+)/);
      const teamIdMatch = stdout.match(/TeamIdentifier=(.+)/);

      return {
        identity: identityMatch?.[1]?.trim(),
        teamId: teamIdMatch?.[1]?.trim(),
      };
    } catch (error) {
      return null;
    }
  }

  /**
   * Removes code signature from an app bundle
   * @param appPath - Path to the app bundle
   * 
   * @example
   * ```typescript
   * const manager = new CodeSignManager();
   * await manager.removeSignature("/path/to/MyApp.app");
   * ```
   */
  async removeSignature(appPath: string): Promise<void> {
    const spinner = p.spinner();
    spinner.start("Removing code signature");

    try {
      await execa("codesign", ["--remove-signature", appPath]);
      spinner.stop("Successfully removed code signature");
    } catch (error) {
      spinner.stop("Failed to remove code signature");
      throw new Error(`Failed to remove signature: ${error}`);
    }
  }

  /**
   * Parses signing identities from security command output
   * @param output - Output from `security find-identity` command
   * @returns Array of parsed signing identities
   * 
   * Input format:
   * ```
   *   1) 1234567890ABCDEF1234567890ABCDEF12345678 "Apple Development: John Doe (TEAMID1234)"
   *   2) ABCDEF1234567890ABCDEF1234567890ABCDEF12 "Apple Distribution: Jane Smith (TEAMID5678)"
   * ```
   */
  private parseSigningIdentities(output: string): SigningIdentity[] {
    const result: SigningIdentity[] = [];
    const lines = output.split("\\n");
    const regex = /^\s*(\d+)\)\s+([A-F0-9]+)\s+"(.+)"$/;

    for (const line of lines) {
      const match = line.match(regex);
      if (match) {
        const hash = match[2];
        const name = match[3];
        result.push({ hash, name });
      }
    }

    return result;
  }
}

/**
 * Creates a new CodeSignManager instance
 * @returns New CodeSignManager instance
 */
export const createCodeSignManager = (): CodeSignManager => {
  return new CodeSignManager();
};