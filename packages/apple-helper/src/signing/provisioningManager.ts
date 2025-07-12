import crypto from "node:crypto";
import fs from "node:fs";
import * as p from "@clack/prompts";
import { execa } from "execa";
import { readBufferFromPlist, readKeyFromPlist } from "../utils/plistManager";

/**
 * Options for generating entitlements file
 */
export interface GenerateEntitlementsOptions {
  /** Path to the decoded provisioning profile plist */
  provisioningPlistPath: string;
  /** Path where entitlements plist should be written */
  outputPath: string;
}

/**
 * Provisioning profile information
 */
export interface ProvisioningProfile {
  /** Profile name */
  name: string;
  /** App ID prefix */
  appIdPrefix: string;
  /** Bundle identifier */
  bundleId: string;
  /** Team identifier */
  teamId: string;
  /** Expiration date */
  expirationDate: Date;
  /** Development certificates */
  developerCertificates: Buffer[];
  /** Entitlements */
  entitlements: Record<string, any>;
}

/**
 * Provisioning profile manager for iOS development
 */
export class ProvisioningManager {
  /**
   * Decodes a provisioning profile to XML plist format
   * @param profilePath - Path to the .mobileprovision file
   * @param outputPath - Path where decoded plist should be written
   *
   * @example
   * ```typescript
   * const manager = new ProvisioningManager();
   * await manager.decodeProvisioningProfileToPlist(
   *   "./profile.mobileprovision",
   *   "./decoded.plist"
   * );
   * ```
   */
  async decodeProvisioningProfileToPlist(
    profilePath: string,
    outputPath: string,
  ): Promise<void> {
    const spinner = p.spinner();
    spinner.start("Decoding provisioning profile");

    try {
      await execa("security", [
        "cms",
        "-D",
        "-i",
        profilePath,
        "-o",
        outputPath,
      ]);
      spinner.stop("Successfully decoded provisioning profile");
    } catch (error) {
      spinner.stop("Failed to decode provisioning profile");
      throw new Error(
        `Failed to decode provisioning profile ${profilePath}: ${error}`,
      );
    }
  }

  /**
   * Generates entitlements plist file from provisioning profile
   * @param options - Generation options
   *
   * @example
   * ```typescript
   * const manager = new ProvisioningManager();
   * await manager.generateEntitlementsPlist({
   *   provisioningPlistPath: "./decoded.plist",
   *   outputPath: "./entitlements.plist"
   * });
   * ```
   */
  async generateEntitlementsPlist(
    options: GenerateEntitlementsOptions,
  ): Promise<void> {
    const spinner = p.spinner();
    spinner.start("Generating entitlements file");

    try {
      const entitlements = await readKeyFromPlist(
        options.provisioningPlistPath,
        "Entitlements",
        { xml: true },
      );

      fs.writeFileSync(options.outputPath, entitlements);
      spinner.stop("Successfully generated entitlements file");
    } catch (error) {
      spinner.stop("Failed to generate entitlements file");
      throw new Error(`Failed to generate entitlements file: ${error}`);
    }
  }

  /**
   * Extracts code signing identity from provisioning profile
   * @param plistPath - Path to the decoded provisioning profile plist
   * @returns Code signing identity name
   *
   * @example
   * ```typescript
   * const manager = new ProvisioningManager();
   * const identity = await manager.getIdentityFromProvisioningPlist("./decoded.plist");
   * console.log(identity); // "Apple Development: John Doe (TEAMID)"
   * ```
   */
  async getIdentityFromProvisioningPlist(
    plistPath: string,
  ): Promise<string | null> {
    try {
      const cert = await readBufferFromPlist(
        plistPath,
        "DeveloperCertificates:0",
      );
      const decodedCert = new crypto.X509Certificate(cert);
      return this.extractCertificateName(decodedCert.subject);
    } catch (error) {
      throw new Error(
        `Failed to extract identity from provisioning profile: ${error}`,
      );
    }
  }

  /**
   * Parses a provisioning profile to extract detailed information
   * @param profilePath - Path to the .mobileprovision file
   * @returns Provisioning profile information
   *
   * @example
   * ```typescript
   * const manager = new ProvisioningManager();
   * const profile = await manager.parseProvisioningProfile("./profile.mobileprovision");
   * console.log(profile.name); // "iOS Team Provisioning Profile: com.example.app"
   * ```
   */
  async parseProvisioningProfile(
    profilePath: string,
  ): Promise<ProvisioningProfile> {
    const tempPlistPath = `${profilePath}.decoded.plist`;

    try {
      // Decode profile to temporary plist
      await this.decodeProvisioningProfileToPlist(profilePath, tempPlistPath);

      // Read profile information
      const [
        name,
        appIdPrefix,
        bundleId,
        teamId,
        expirationDateStr,
        entitlements,
      ] = await Promise.all([
        readKeyFromPlist(tempPlistPath, "Name"),
        readKeyFromPlist(tempPlistPath, "ApplicationIdentifierPrefix:0"),
        readKeyFromPlist(tempPlistPath, "Entitlements:application-identifier"),
        readKeyFromPlist(tempPlistPath, "TeamIdentifier:0"),
        readKeyFromPlist(tempPlistPath, "ExpirationDate"),
        readKeyFromPlist(tempPlistPath, "Entitlements", { xml: true }),
      ]);

      // Read developer certificates
      const cert = await readBufferFromPlist(
        tempPlistPath,
        "DeveloperCertificates:0",
      );

      return {
        name,
        appIdPrefix,
        bundleId: bundleId.replace(`${appIdPrefix}.`, ""),
        teamId,
        expirationDate: new Date(expirationDateStr),
        developerCertificates: [cert],
        entitlements: JSON.parse(entitlements),
      };
    } finally {
      // Clean up temporary file
      try {
        fs.unlinkSync(tempPlistPath);
      } catch {
        // Ignore cleanup errors
      }
    }
  }

  /**
   * Validates that a provisioning profile is valid for a bundle ID
   * @param profilePath - Path to the .mobileprovision file
   * @param bundleId - Bundle identifier to validate against
   * @returns True if profile matches bundle ID
   *
   * @example
   * ```typescript
   * const manager = new ProvisioningManager();
   * const isValid = await manager.validateProfile("./profile.mobileprovision", "com.example.app");
   * console.log(isValid); // true or false
   * ```
   */
  async validateProfile(
    profilePath: string,
    bundleId: string,
  ): Promise<boolean> {
    try {
      const profile = await this.parseProvisioningProfile(profilePath);

      // Check if bundle ID matches (supports wildcards)
      if (profile.bundleId === "*") {
        return true; // Wildcard profile
      }

      if (profile.bundleId.endsWith("*")) {
        const prefix = profile.bundleId.slice(0, -1);
        return bundleId.startsWith(prefix);
      }

      return profile.bundleId === bundleId;
    } catch (error) {
      p.log.warn(`Failed to validate provisioning profile: ${error}`);
      return false;
    }
  }

  /**
   * Lists installed provisioning profiles
   * @returns Array of provisioning profile paths
   *
   * @example
   * ```typescript
   * const manager = new ProvisioningManager();
   * const profiles = await manager.listInstalledProfiles();
   * console.log(profiles.length); // Number of installed profiles
   * ```
   */
  async listInstalledProfiles(): Promise<string[]> {
    const profilesDir = `${process.env.HOME}/Library/MobileDevice/Provisioning Profiles`;

    try {
      const files = fs.readdirSync(profilesDir);
      return files
        .filter((file) => file.endsWith(".mobileprovision"))
        .map((file) => `${profilesDir}/${file}`);
    } catch (error) {
      return [];
    }
  }

  /**
   * Extracts certificate name from subject field
   * @param subject - Certificate subject string
   * @returns Certificate common name (CN) or null if not found
   */
  private extractCertificateName(subject: string): string | null {
    const regex = /CN=(.+)$/m;
    const match = subject.match(regex);
    return match ? match[1] : null;
  }
}

/**
 * Creates a new ProvisioningManager instance
 * @returns New ProvisioningManager instance
 */
export const createProvisioningManager = (): ProvisioningManager => {
  return new ProvisioningManager();
};
