import fs from "fs";
import path from "path";
import { getCwd } from "@hot-updater/plugin-core";
import { globby } from "globby";
import plist from "plist";

interface ConfigParser {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<{ path: string }>;
  exists(): Promise<boolean>;
}

interface GradleBlock {
  startLine: number;
  endLine: number;
  indent: string;
}

export class AndroidConfigParser implements ConfigParser {
  private buildGradlePath: string;

  constructor() {
    this.buildGradlePath = path.join(
      getCwd(),
      "android",
      "app",
      "build.gradle",
    );
  }

  async exists(): Promise<boolean> {
    return fs.existsSync(this.buildGradlePath);
  }

  async get(key: string): Promise<string | null> {
    if (!(await this.exists())) {
      throw new Error("build.gradle not found");
    }

    const content = await fs.promises.readFile(this.buildGradlePath, "utf-8");
    const lines = content.split("\n");

    const androidBlock = this.findBlock(lines, "android");
    if (!androidBlock) {
      return null;
    }

    const defaultConfigBlock = this.findBlock(
      lines,
      "defaultConfig",
      androidBlock,
    );
    if (!defaultConfigBlock) {
      return null;
    }

    const fieldIndex = this.findBuildConfigField(
      lines,
      key,
      defaultConfigBlock,
    );
    if (fieldIndex === -1) {
      return null;
    }

    const line = lines[fieldIndex];
    if (!line) {
      return null;
    }

    const match = line.match(
      /buildConfigField\s+["']String["']\s*,\s*["'].*?["']\s*,\s*["'](.*)["']/,
    );
    return match ? (match[1] ?? null) : null;
  }

  async set(key: string, value: string): Promise<{ path: string }> {
    if (!(await this.exists())) {
      throw new Error("build.gradle not found");
    }

    const content = await fs.promises.readFile(this.buildGradlePath, "utf-8");
    const lines = content.split("\n");

    const result = this.parseAndUpdateGradle(lines, key, value);

    const newContent = result.join("\n");
    await fs.promises.writeFile(this.buildGradlePath, newContent);
    return { path: path.relative(getCwd(), this.buildGradlePath) };
  }

  private parseAndUpdateGradle(
    lines: string[],
    key: string,
    value: string,
  ): string[] {
    const androidBlock = this.findBlock(lines, "android");
    if (!androidBlock) {
      throw new Error("android block not found in build.gradle");
    }

    const defaultConfigBlock = this.findBlock(
      lines,
      "defaultConfig",
      androidBlock,
    );
    if (!defaultConfigBlock) {
      throw new Error("defaultConfig block not found in build.gradle");
    }

    // Find existing buildConfigField
    const fieldIndex = this.findBuildConfigField(
      lines,
      key,
      defaultConfigBlock,
    );

    if (fieldIndex !== -1 && lines[fieldIndex]) {
      // Update existing field
      const indent = this.getLineIndent(lines[fieldIndex]);
      lines[fieldIndex] =
        `${indent}buildConfigField "String", "${key}", "${value}"`;
    } else if (defaultConfigBlock) {
      // Add new field to defaultConfig block
      const insertIndex = defaultConfigBlock.endLine;
      const indent = `${defaultConfigBlock.indent}    `;
      lines.splice(
        insertIndex,
        0,
        `${indent}buildConfigField "String", "${key}", "${value}"`,
      );
    } else {
      // Create defaultConfig block itself
      const insertIndex = androidBlock.endLine;
      const indent = `${androidBlock.indent}    `;
      const defaultConfigLines = [
        `${indent}defaultConfig {`,
        `${indent}    buildConfigField "String", "${key}", "${value}"`,
        `${indent}}`,
      ];
      lines.splice(insertIndex, 0, ...defaultConfigLines);
    }

    return lines;
  }

  private findBlock(
    lines: string[],
    blockName: string,
    parentBlock?: GradleBlock,
  ): GradleBlock | null {
    const startIndex = parentBlock ? parentBlock.startLine + 1 : 0;
    const endIndex = parentBlock ? parentBlock.endLine : lines.length;

    let braceCount = 0;
    let blockStart = -1;
    let blockIndent = "";

    for (let i = startIndex; i < endIndex; i++) {
      const line = lines[i];
      if (!line) {
        continue;
      }

      const trimmedLine = line.trim();

      if (
        blockStart === -1 &&
        trimmedLine.includes(blockName) &&
        trimmedLine.includes("{")
      ) {
        blockStart = i;
        blockIndent = this.getLineIndent(line);
        braceCount = 1;

        const openBraces = (trimmedLine.match(/\{/g) || []).length;
        const closeBraces = (trimmedLine.match(/\}/g) || []).length;
        braceCount = openBraces - closeBraces;

        if (braceCount === 0) {
          return { startLine: blockStart, endLine: i, indent: blockIndent };
        }
        continue;
      }

      if (blockStart !== -1) {
        const openBraces = (line.match(/\{/g) || []).length;
        const closeBraces = (line.match(/\}/g) || []).length;
        braceCount += openBraces - closeBraces;

        if (braceCount === 0) {
          return { startLine: blockStart, endLine: i, indent: blockIndent };
        }
      }
    }

    return null;
  }

  private findBuildConfigField(
    lines: string[],
    key: string,
    searchBlock?: GradleBlock,
  ): number {
    const startIndex = searchBlock ? searchBlock.startLine + 1 : 0;
    const endIndex = searchBlock ? searchBlock.endLine : lines.length;

    for (let i = startIndex; i < endIndex; i++) {
      const line = lines[i]?.trim();
      if (!line) {
        continue;
      }

      if (
        line.includes("buildConfigField") &&
        line.includes(key) &&
        (line.includes('"String"') || line.includes("'String'"))
      ) {
        return i;
      }
    }

    return -1;
  }

  private getLineIndent(line: string): string {
    const match = line.match(/^(\s*)/);
    return match ? (match[1] ?? "") : "";
  }
}

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

  async get(key: string): Promise<string | null> {
    const plistFile = await this.getPlistPath();
    const plistXml = await fs.promises.readFile(plistFile, "utf-8");
    const plistObject = plist.parse(plistXml) as { [key: string]: any };

    return plistObject[key] || null;
  }

  async set(key: string, value: string): Promise<{ path: string }> {
    const plistFile = await this.getPlistPath();
    const plistXml = await fs.promises.readFile(plistFile, "utf-8");
    const plistObject = plist.parse(plistXml) as { [key: string]: any };

    plistObject[key] = value;

    const newPlistXml = plist.build(plistObject, { indent: "\t", offset: -1 });
    await fs.promises.writeFile(plistFile, newPlistXml);

    return { path: path.relative(getCwd(), plistFile) };
  }
}
