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

  private async getXcconfigPath(flavor: string): Promise<string> {
    const iosDir = path.join(getCwd(), "ios");

    // Common xcconfig file patterns
    const patterns = [
      `**/${flavor}.xcconfig`,
      `**/${flavor.charAt(0).toUpperCase() + flavor.slice(1)}.xcconfig`,
      `**/Config/${flavor}.xcconfig`,
      `**/Configurations/${flavor}.xcconfig`,
    ];

    for (const pattern of patterns) {
      const [xcconfigFile] = await globby(pattern, {
        cwd: iosDir,
        absolute: true,
        onlyFiles: true,
      });
      if (xcconfigFile) {
        return xcconfigFile;
      }
    }

    // If not found, create new xcconfig file
    const xcconfigPath = path.join(iosDir, `${flavor}.xcconfig`);
    return xcconfigPath;
  }

  private async readXcconfigFile(
    filePath: string,
  ): Promise<Record<string, string>> {
    try {
      const content = await fs.promises.readFile(filePath, "utf-8");
      const config: Record<string, string> = {};

      const lines = content.split("\n");
      for (const line of lines) {
        const trimmedLine = line.trim();
        if (
          trimmedLine &&
          !trimmedLine.startsWith("//") &&
          !trimmedLine.startsWith("#")
        ) {
          const match = trimmedLine.match(/^([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
          if (match?.[1] && match[2] !== undefined) {
            config[match[1]] = match[2].trim();
          }
        }
      }

      return config;
    } catch (error) {
      // File doesn't exist or can't be read
      return {};
    }
  }

  private async writeXcconfigFile(
    filePath: string,
    config: Record<string, string>,
  ): Promise<void> {
    const lines: string[] = [];
    lines.push(
      "// Configuration settings file format documentation can be found at:",
    );
    lines.push("// https://help.apple.com/xcode/#/dev745c5c974");
    lines.push("");

    for (const [key, value] of Object.entries(config)) {
      lines.push(`${key} = ${value}`);
    }
    const content = `${lines.join("\n")}\n`;

    // Ensure directory exists
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    await fs.promises.writeFile(filePath, content, "utf-8");
  }

  private async getAllXcconfigFiles(): Promise<string[]> {
    const iosDir = path.join(getCwd(), "ios");

    const xcconfigFiles = await globby("**/*.xcconfig", {
      cwd: iosDir,
      absolute: true,
      onlyFiles: true,
    });

    return xcconfigFiles;
  }

  private getFlavorNameFromPath(xcconfigPath: string): string {
    const basename = path.basename(xcconfigPath, ".xcconfig");
    return basename.toLowerCase();
  }

  async exists(): Promise<boolean> {
    try {
      await this.getPlistPath();
      return true;
    } catch {
      return false;
    }
  }

  async get(
    key: string,
  ): Promise<{ default?: string; [flavor: string]: string | undefined }> {
    const result: { default?: string; [flavor: string]: string | undefined } =
      {};

    // Check Info.plist for default value
    try {
      const plistFile = await this.getPlistPath();
      const plistXml = await fs.promises.readFile(plistFile, "utf-8");
      const plistObject = plist.parse(plistXml) as { [key: string]: any };

      const plistValue = plistObject[key];
      if (plistValue !== undefined) {
        // Check if it's a variable reference like $(KEY_NAME)
        if (
          typeof plistValue === "string" &&
          plistValue.match(/^\$\([A-Z_][A-Z0-9_]*\)$/)
        ) {
          // This is a variable reference, don't treat as default value
        } else {
          result.default = String(plistValue);
        }
      }
    } catch (error) {
      // Info.plist not found or can't be read
    }

    // Check all xcconfig files for flavor-specific values
    try {
      const xcconfigFiles = await this.getAllXcconfigFiles();

      for (const xcconfigFile of xcconfigFiles) {
        const flavorName = this.getFlavorNameFromPath(xcconfigFile);
        const config = await this.readXcconfigFile(xcconfigFile);

        if (config[key]) {
          result[flavorName] = config[key];
        }
      }
    } catch (error) {
      // xcconfig files not found or can't be read
    }

    return result;
  }

  async set(
    key: string,
    value: string,
    options?: { flavor?: string },
  ): Promise<{ path: string }> {
    if (options?.flavor) {
      // Set in xcconfig file for specific flavor
      const xcconfigPath = await this.getXcconfigPath(options.flavor);
      const config = await this.readXcconfigFile(xcconfigPath);

      config[key] = value;
      await this.writeXcconfigFile(xcconfigPath, config);

      // Update Info.plist to reference the xcconfig variable
      const plistFile = await this.getPlistPath();
      const plistXml = await fs.promises.readFile(plistFile, "utf-8");
      const plistObject = plist.parse(plistXml) as { [key: string]: any };

      // Set the variable reference in Info.plist
      plistObject[key] = `$(${key})`;

      const newPlistXml = plist.build(plistObject, {
        indent: "\t",
        offset: -1,
      });
      await fs.promises.writeFile(plistFile, newPlistXml);

      return { path: path.relative(getCwd(), xcconfigPath) };
    }

    // Set directly in Info.plist as default value
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
