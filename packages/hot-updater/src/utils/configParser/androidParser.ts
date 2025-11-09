import { getCwd } from "@hot-updater/cli-tools";
import { XMLBuilder, XMLParser } from "fast-xml-parser";
import fs from "fs";
import path from "path";
import type { ConfigParser } from "./configParser";

interface StringElement {
  "@_name": string;
  "@_moduleConfig"?: string;
  "#text"?: string;
}

interface ResourcesXml {
  resources: {
    string?: StringElement | StringElement[];
  };
}

export class AndroidConfigParser implements ConfigParser {
  private stringsXmlPaths: string[];
  private parser: XMLParser;
  private builder: XMLBuilder;

  constructor(customPaths?: string[]) {
    // Convert to absolute paths
    this.stringsXmlPaths = (customPaths || []).map((p) =>
      path.isAbsolute(p) ? p : path.join(getCwd(), p),
    );

    const options = {
      ignoreAttributes: false,
      attributeNamePrefix: "@_",
      textNodeName: "#text",
      format: true,
      indentBy: "    ",
      suppressEmptyNode: true,
    };

    this.parser = new XMLParser(options);
    this.builder = new XMLBuilder({
      ...options,
      format: true,
      indentBy: "    ",
      suppressBooleanAttributes: false,
      processEntities: true,
    });
  }

  async exists(): Promise<boolean> {
    return this.stringsXmlPaths.some((path) => fs.existsSync(path));
  }

  private getExistingPaths(): string[] {
    return this.stringsXmlPaths.filter((path) => fs.existsSync(path));
  }

  async get(key: string): Promise<{
    value: string | null;
    paths: string[];
  }> {
    const existingPaths = this.getExistingPaths();
    const searchedPaths: string[] = [];

    if (existingPaths.length === 0) {
      return {
        value: null,
        paths: [],
      };
    }

    // Check each existing path until we find the key
    for (const stringsXmlPath of existingPaths) {
      const relativePath = path.relative(getCwd(), stringsXmlPath);
      searchedPaths.push(relativePath);

      try {
        const content = await fs.promises.readFile(stringsXmlPath, "utf-8");
        const result = this.parser.parse(content) as ResourcesXml;

        if (!result.resources.string) {
          continue;
        }

        // Handle both single string and array of strings
        const strings = Array.isArray(result.resources.string)
          ? result.resources.string
          : [result.resources.string];

        const stringElement = strings.find(
          (str) => str["@_name"] === key && str["@_moduleConfig"] === "true",
        );

        if (stringElement?.["#text"]) {
          return {
            value: stringElement["#text"].trim(),
            paths: searchedPaths,
          };
        }
      } catch (error) {
        throw new Error(`Failed to get ${stringsXmlPath}: ${error}`);
      }
    }

    return {
      value: null,
      paths: searchedPaths,
    };
  }

  async set(key: string, value: string): Promise<{ paths: string[] }> {
    const existingPaths = this.getExistingPaths();

    if (existingPaths.length === 0) {
      console.warn(
        "hot-updater: No strings.xml files found. Skipping Android-specific config modifications.",
      );
      return { paths: [] };
    }

    const updatedPaths: string[] = [];

    // Update all existing files
    for (const stringsXmlPath of existingPaths) {
      try {
        const content = await fs.promises.readFile(stringsXmlPath, "utf-8");
        const result = this.parser.parse(content) as ResourcesXml;

        // Ensure resources.string exists
        if (!result.resources.string) {
          result.resources.string = [];
        }

        // Convert to array if it's a single object
        const strings = Array.isArray(result.resources.string)
          ? result.resources.string
          : [result.resources.string];

        // Find existing string element with moduleConfig="true"
        const existingIndex = strings.findIndex(
          (str) => str["@_name"] === key && str["@_moduleConfig"] === "true",
        );

        const stringElement: StringElement = {
          "@_name": key,
          "@_moduleConfig": "true",
          "#text": value,
        };

        if (existingIndex !== -1) {
          // Update existing element
          strings[existingIndex] = stringElement;
        } else {
          // Add new element
          strings.push(stringElement);
        }

        // Update the result
        result.resources.string = strings.length === 1 ? strings[0] : strings;

        // XMLBuilder already includes the XML declaration, so we don't need to add it manually
        const newContent = this.builder.build(result);

        await fs.promises.writeFile(stringsXmlPath, newContent, "utf-8");
        updatedPaths.push(path.relative(getCwd(), stringsXmlPath));
      } catch (error) {
        throw new Error(`Failed to parse or update strings.xml: ${error}`);
      }
    }

    return {
      paths: updatedPaths,
    };
  }
}
