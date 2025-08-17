import fs from "fs";
import path from "path";
import { getCwd } from "@hot-updater/plugin-core";
import fg from "fast-glob";
import plist from "plist";
import type { ConfigParser } from "./configParser";

// iOS Info.plist parser
export class IosConfigParser implements ConfigParser {
  private customPaths?: string[];

  constructor(customPaths?: string[]) {
    this.customPaths = customPaths;
  }

  private async getPlistPaths(): Promise<string[]> {
    if (this.customPaths) {
      // Use custom paths, resolve them relative to cwd
      return this.customPaths
        .map((p) => (path.isAbsolute(p) ? p : path.join(getCwd(), p)))
        .filter((p) => fs.existsSync(p));
    }

    // Default behavior: find all Info.plist files in ios directory
    const plistFiles = await fg.glob("*/Info.plist", {
      cwd: path.join(getCwd(), "ios"),
      absolute: true,
      onlyFiles: true,
    });

    return plistFiles;
  }

  async exists(): Promise<boolean> {
    const paths = await this.getPlistPaths();
    return paths.length > 0;
  }

  async get(
    key: string,
  ): Promise<{ value: string | null; path: string | null }> {
    const plistPaths = await this.getPlistPaths();

    if (plistPaths.length === 0) {
      return {
        value: null,
        path: null,
      };
    }

    // Check each plist file until we find the key
    for (const plistFile of plistPaths) {
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
          path: path.relative(getCwd(), plistFile),
        };
      }
    }

    return {
      value: null,
      path: path.relative(getCwd(), plistPaths[0] || ""),
    };
  }

  async set(key: string, value: string): Promise<{ path: string | null }> {
    const plistPaths = await this.getPlistPaths();

    if (plistPaths.length === 0) {
      console.warn(
        "hot-updater: No Info.plist files found. Skipping iOS-specific config modifications.",
      );
      return { path: null };
    }

    const updatedPaths: string[] = [];

    // Update all existing plist files
    for (const plistFile of plistPaths) {
      try {
        const plistXml = await fs.promises.readFile(plistFile, "utf-8");
        const plistObject = plist.parse(plistXml) as Record<string, any>;

        plistObject[key] = value;

        const newPlistXml = plist.build(plistObject, {
          indent: "\t",
          pretty: true,
        });

        await fs.promises.writeFile(plistFile, newPlistXml);
        updatedPaths.push(path.relative(getCwd(), plistFile));
      } catch (error) {
        throw new Error(`Failed to parse or update Info.plist: ${error}`);
      }
    }

    return {
      path: updatedPaths.length > 0 ? updatedPaths.join(", ") : null,
    };
  }
}
