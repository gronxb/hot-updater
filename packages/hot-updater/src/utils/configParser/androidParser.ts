import fs from "fs";
import path from "path";
import { getCwd } from "@hot-updater/plugin-core";
import type { ConfigParser } from "./configParser";

interface GradleBlock {
  startLine: number;
  endLine: number;
  indent: string;
}

interface FlavorBlock extends GradleBlock {
  name: string;
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

  async get(
    key: string,
  ): Promise<{ default?: string; [flavor: string]: string | undefined }> {
    if (!(await this.exists())) {
      throw new Error("build.gradle not found");
    }

    const content = await fs.promises.readFile(this.buildGradlePath, "utf-8");
    const lines = content.split("\n");

    const androidBlock = this.findBlock(lines, "android");
    if (!androidBlock) {
      return {};
    }

    const result: { default?: string; [flavor: string]: string | undefined } =
      {};

    // Get default value from defaultConfig
    const defaultConfigBlock = this.findBlock(
      lines,
      "defaultConfig",
      androidBlock,
    );
    if (defaultConfigBlock) {
      const fieldIndex = this.findBuildConfigField(
        lines,
        key,
        defaultConfigBlock,
      );
      if (fieldIndex !== -1) {
        const line = lines[fieldIndex];
        if (line) {
          const match = line.match(
            /buildConfigField\s+["']String["']\s*,\s*["'].*?["']\s*,\s*["'](.*)["']/,
          );
          if (match?.[1]) {
            // Remove surrounding escaped quotes: "\"value\"" -> value
            let value = match[1];
            if (value.startsWith('\\"') && value.endsWith('\\"')) {
              value = value.slice(2, -2);
            }
            result.default = value;
          }
        }
      }
    }

    // Check for productFlavors
    const productFlavorsBlock = this.findBlock(
      lines,
      "productFlavors",
      androidBlock,
    );

    if (productFlavorsBlock) {
      // Find all flavor blocks
      const flavorBlocks = this.findFlavorBlocks(lines, productFlavorsBlock);

      for (const flavorBlock of flavorBlocks) {
        const fieldIndex = this.findBuildConfigField(lines, key, flavorBlock);
        if (fieldIndex !== -1) {
          const line = lines[fieldIndex];
          if (line) {
            const match = line.match(
              /buildConfigField\s+["']String["']\s*,\s*["'].*?["']\s*,\s*["'](.*)["']/,
            );
            if (match?.[1]) {
              // Remove surrounding escaped quotes: "\"value\"" -> value
              let value = match[1];
              if (value.startsWith('\\"') && value.endsWith('\\"')) {
                value = value.slice(2, -2);
              }
              result[flavorBlock.name] = value;
            }
          }
        }
      }
    }

    return result;
  }

  async set(
    key: string,
    value: string,
    options?: { flavor?: string },
  ): Promise<{ path: string }> {
    if (!(await this.exists())) {
      throw new Error("build.gradle not found");
    }

    const content = await fs.promises.readFile(this.buildGradlePath, "utf-8");
    const lines = content.split("\n");

    let result: string[];

    if (options?.flavor) {
      // Set in specific flavor
      result = this.parseAndUpdateGradleWithFlavor(
        lines,
        key,
        value,
        options.flavor,
      );
    } else {
      // Set in defaultConfig
      result = this.parseAndUpdateGradle(lines, key, value);
    }

    const newContent = result.join("\n");
    await fs.promises.writeFile(this.buildGradlePath, newContent);
    return { path: path.relative(getCwd(), this.buildGradlePath) };
  }

  private parseAndUpdateGradleWithFlavor(
    lines: string[],
    key: string,
    value: string,
    flavorName: string,
  ): string[] {
    const androidBlock = this.findBlock(lines, "android");
    if (!androidBlock) {
      throw new Error("android block not found in build.gradle");
    }

    let productFlavorsBlock = this.findBlock(
      lines,
      "productFlavors",
      androidBlock,
    );

    // Create productFlavors block if it doesn't exist
    if (!productFlavorsBlock) {
      productFlavorsBlock = this.createProductFlavorsBlock(lines, androidBlock);
    }

    const flavorBlocks = this.findFlavorBlocks(lines, productFlavorsBlock);
    let flavorBlock = flavorBlocks.find((fb) => fb.name === flavorName);

    // Create flavor block if it doesn't exist
    if (!flavorBlock) {
      flavorBlock = this.createFlavorBlock(
        lines,
        productFlavorsBlock,
        flavorName,
      );
    }

    // Find existing buildConfigField in this flavor
    const fieldIndex = this.findBuildConfigField(lines, key, flavorBlock);

    if (fieldIndex !== -1 && lines[fieldIndex]) {
      // Update existing field
      const indent = this.getLineIndent(lines[fieldIndex]);
      lines[fieldIndex] =
        `${indent}buildConfigField "String", "${key}", "\\"${value}\\""`;
    } else {
      // Add new field to flavor block
      const insertIndex = flavorBlock.endLine;
      const indent = `${flavorBlock.indent}    `;
      lines.splice(
        insertIndex,
        0,
        `${indent}buildConfigField "String", "${key}", "\\"${value}\\""`,
      );
    }

    return lines;
  }

  private createProductFlavorsBlock(
    lines: string[],
    androidBlock: GradleBlock,
  ): GradleBlock {
    const insertIndex = androidBlock.endLine;
    const indent = `${androidBlock.indent}    `;

    const productFlavorsLines = [`${indent}productFlavors {`, `${indent}}`];

    lines.splice(insertIndex, 0, ...productFlavorsLines);

    // Return the newly created productFlavors block
    return {
      startLine: insertIndex,
      endLine: insertIndex + 1,
      indent: indent,
    };
  }

  private createFlavorBlock(
    lines: string[],
    productFlavorsBlock: GradleBlock,
    flavorName: string,
  ): FlavorBlock {
    const insertIndex = productFlavorsBlock.endLine;
    const indent = `${productFlavorsBlock.indent}    `;

    const flavorLines = [`${indent}${flavorName} {`, `${indent}}`];

    lines.splice(insertIndex, 0, ...flavorLines);

    // Update productFlavorsBlock endLine since we inserted lines
    productFlavorsBlock.endLine += flavorLines.length;

    // Return the newly created flavor block
    return {
      startLine: insertIndex,
      endLine: insertIndex + 1,
      indent: indent,
      name: flavorName,
    };
  }

  private findFlavorBlocks(
    lines: string[],
    productFlavorsBlock: GradleBlock,
  ): FlavorBlock[] {
    const flavorBlocks: FlavorBlock[] = [];
    const startIndex = productFlavorsBlock.startLine + 1;
    const endIndex = productFlavorsBlock.endLine;

    let i = startIndex;
    while (i < endIndex) {
      const line = lines[i];
      if (!line) {
        i++;
        continue;
      }

      const trimmedLine = line.trim();

      // Look for flavor block (identifier followed by {)
      const flavorMatch = trimmedLine.match(/^(\w+)\s*\{/);
      if (flavorMatch) {
        const flavorName = flavorMatch[1];
        if (flavorName) {
          const flavorBlock = this.findBlock(
            lines,
            flavorName,
            productFlavorsBlock,
          );
          if (flavorBlock) {
            flavorBlocks.push({
              ...flavorBlock,
              name: flavorName,
            });
            i = flavorBlock.endLine + 1;
            continue;
          }
        }
      }
      i++;
    }

    return flavorBlocks;
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
        `${indent}buildConfigField "String", "${key}", "\\"${value}\\""`;
    } else if (defaultConfigBlock) {
      // Add new field to defaultConfig block
      const insertIndex = defaultConfigBlock.endLine;
      const indent = `${defaultConfigBlock.indent}    `;
      lines.splice(
        insertIndex,
        0,
        `${indent}buildConfigField "String", "${key}", "\\"${value}\\""`,
      );
    } else {
      // Create defaultConfig block itself
      const insertIndex = androidBlock.endLine;
      const indent = `${androidBlock.indent}    `;
      const defaultConfigLines = [
        `${indent}defaultConfig {`,
        `${indent}    buildConfigField "String", "${key}", "\\"${value}\\""`,
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
