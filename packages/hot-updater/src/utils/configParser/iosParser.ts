import { getCwd } from "@hot-updater/cli-tools";
import fs from "fs";
import path from "path";
import plist from "plist";
import type { ConfigParser } from "./configParser";

// iOS Info.plist parser
export class IosConfigParser implements ConfigParser {
  private plistPaths: string[];

  constructor(customPaths?: string[]) {
    this.plistPaths = customPaths || [];
  }

  private getPlistPaths(): string[] {
    // Use provided paths, resolve them relative to cwd and filter existing files
    return this.plistPaths
      .map((p) => (path.isAbsolute(p) ? p : path.join(getCwd(), p)))
      .filter((p) => fs.existsSync(p));
  }

  async exists(): Promise<boolean> {
    const paths = this.getPlistPaths();
    return paths.length > 0;
  }

  async get(key: string): Promise<{ value: string | null; paths: string[] }> {
    const plistPaths = this.getPlistPaths();
    const searchedPaths: string[] = [];

    if (plistPaths.length === 0) {
      return {
        value: null,
        paths: [],
      };
    }

    // Check each plist file until we find the key
    for (const plistFile of plistPaths) {
      const relativePath = path.relative(getCwd(), plistFile);
      searchedPaths.push(relativePath);

      const plistXml = await fs.promises.readFile(plistFile, "utf-8");
      const plistObject = plist.parse(plistXml) as Record<string, any>;

      // Check if the key exists in the plist
      if (key in plistObject) {
        const value = plistObject[key];

        // Handle different value types
        if (value === null || value === undefined) {
          continue; // Try next file
        }

        // Convert to string if it's not already
        const stringValue = typeof value === "string" ? value : String(value);

        return {
          value: stringValue,
          paths: searchedPaths,
        };
      }
    }

    return {
      value: null,
      paths: searchedPaths,
    };
  }

  async remove(key: string): Promise<{ paths: string[] }> {
    const plistPaths = this.getPlistPaths();

    if (plistPaths.length === 0) {
      return { paths: [] };
    }

    const updatedPaths: string[] = [];

    for (const plistFile of plistPaths) {
      const relativePath = path.relative(getCwd(), plistFile);
      try {
        const plistXml = await fs.promises.readFile(plistFile, "utf-8");
        const plistObject = plist.parse(plistXml) as Record<string, any>;

        if (!(key in plistObject)) {
          continue;
        }

        delete plistObject[key];

        const newPlistXml = plist.build(plistObject, {
          indent: "\t",
          pretty: true,
        });

        await fs.promises.writeFile(plistFile, newPlistXml);
        updatedPaths.push(relativePath);
      } catch (error) {
        throw new Error(
          `Failed to remove key from Info.plist at '${relativePath}': ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    return { paths: updatedPaths };
  }

  async set(key: string, value: string): Promise<{ paths: string[] }> {
    const plistPaths = this.getPlistPaths();

    if (plistPaths.length === 0) {
      console.warn(
        "hot-updater: No Info.plist files found. Skipping iOS-specific config modifications.",
      );
      return { paths: [] };
    }

    const updatedPaths: string[] = [];

    // Update all existing plist files
    for (const plistFile of plistPaths) {
      const relativePath = path.relative(getCwd(), plistFile);
      try {
        const plistXml = await fs.promises.readFile(plistFile, "utf-8");

        // Basic XML validation
        if (!plistXml.trim().startsWith("<?xml")) {
          throw new Error(
            "File does not appear to be valid XML: missing XML declaration",
          );
        }

        if (!plistXml.includes("<plist") || !plistXml.includes("</plist>")) {
          throw new Error(
            "File does not appear to be a valid plist: missing plist tags",
          );
        }

        const plistObject = plist.parse(plistXml) as Record<string, any>;

        plistObject[key] = value;

        const newPlistXml = plist.build(plistObject, {
          indent: "\t",
          pretty: true,
        });

        await fs.promises.writeFile(plistFile, newPlistXml);
        updatedPaths.push(relativePath);
      } catch (error) {
        throw new Error(
          `Failed to parse or update Info.plist at '${relativePath}': ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    return {
      paths: updatedPaths,
    };
  }
}
