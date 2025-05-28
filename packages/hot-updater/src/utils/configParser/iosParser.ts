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

  async get(key: string): Promise<string | undefined> {
    try {
      const plistFile = await this.getPlistPath();
      const plistXml = await fs.promises.readFile(plistFile, "utf-8");
      const plistObject = plist.parse(plistXml) as { [key: string]: any };

      const plistValue = plistObject[key];
      if (plistValue !== undefined) {
        return String(plistValue);
      }
    } catch (error) {
      // Info.plist not found or can't be read
    }

    return undefined;
  }

  async set(key: string, value: string): Promise<{ path: string }> {
    const plistFile = await this.getPlistPath();
    const plistXml = await fs.promises.readFile(plistFile, "utf-8");
    const plistObject = plist.parse(plistXml) as { [key: string]: any };

    plistObject[key] = value;

    const newPlistXml = plist.build(plistObject, {
      indent: "\t",
      offset: -1,
    });
    await fs.promises.writeFile(plistFile, newPlistXml);

    return { path: path.relative(getCwd(), plistFile) };
  }
}
