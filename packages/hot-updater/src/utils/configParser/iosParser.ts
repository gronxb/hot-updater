import fs from "fs";
import path from "path";
import { getCwd } from "@hot-updater/plugin-core";
import { globby } from "globby";
import plist from "plist";
import type { ConfigParser } from "./configParser";

// iOS Info.plist parser
export class IosConfigParser implements ConfigParser {
  private async getPlistPath(): Promise<string> {
    const [plistFile] = await globby("*/Info.plist", {
      cwd: path.join(getCwd(), "ios"),
      absolute: true,
      onlyFiles: true,
    });
    if (!plistFile) {
      throw new Error("Info.plist not found");
    }
    return plistFile;
  }

  async exists(): Promise<boolean> {
    try {
      await this.getPlistPath();
      return true;
    } catch {
      return false;
    }
  }

  async get(key: string): Promise<{ value: string | null; path: string }> {
    try {
      const plistFile = await this.getPlistPath();
      const plistXml = await fs.promises.readFile(plistFile, "utf-8");

      // Parse the plist file
      const plistObject = plist.parse(plistXml) as Record<string, any>;

      // Check if the key exists in the plist
      if (key in plistObject) {
        const value = plistObject[key];

        // Handle different value types
        if (value === null || value === undefined) {
          return {
            value: null,
            path: path.relative(getCwd(), plistFile),
          };
        }

        // Convert to string if it's not already
        if (typeof value === "string") {
          return {
            value,
            path: path.relative(getCwd(), plistFile),
          };
        }
        return {
          value: String(value),
          path: path.relative(getCwd(), plistFile),
        };
      }

      return {
        value: null,
        path: path.relative(getCwd(), plistFile),
      };
    } catch (error) {
      return {
        value: null,
        path: path.relative(getCwd(), await this.getPlistPath()),
      };
    }
  }

  async set(key: string, value: string): Promise<{ path: string }> {
    const plistFile = await this.getPlistPath();
    const plistXml = await fs.promises.readFile(plistFile, "utf-8");
    const plistObject = plist.parse(plistXml) as Record<string, any>;

    plistObject[key] = value;

    const newPlistXml = plist.build(plistObject, {
      indent: "\t",
      pretty: true,
    });

    await fs.promises.writeFile(plistFile, newPlistXml);

    return { path: path.relative(getCwd(), plistFile) };
  }
}
