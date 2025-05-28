import fs from "fs";
import path from "path";
import { getCwd } from "@hot-updater/plugin-core";
import { XMLBuilder, XMLParser } from "fast-xml-parser";
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
  private stringsXmlPath: string;
  private parser: XMLParser;
  private builder: XMLBuilder;

  constructor() {
    this.stringsXmlPath = path.join(
      getCwd(),
      "android",
      "app",
      "src",
      "main",
      "res",
      "values",
      "strings.xml",
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
    return fs.existsSync(this.stringsXmlPath);
  }

  async get(key: string): Promise<string | undefined> {
    if (!(await this.exists())) {
      return undefined;
    }

    try {
      const content = await fs.promises.readFile(this.stringsXmlPath, "utf-8");
      const result = this.parser.parse(content) as ResourcesXml;

      if (!result.resources.string) {
        return undefined;
      }

      // Handle both single string and array of strings
      const strings = Array.isArray(result.resources.string)
        ? result.resources.string
        : [result.resources.string];

      const stringElement = strings.find(
        (str) => str["@_name"] === key && str["@_moduleConfig"] === "true",
      );

      return stringElement?.["#text"]?.trim();
    } catch (error) {
      return undefined;
    }
  }

  async set(key: string, value: string): Promise<{ path: string }> {
    if (!(await this.exists())) {
      throw new Error("strings.xml not found");
    }

    const content = await fs.promises.readFile(this.stringsXmlPath, "utf-8");

    try {
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

      await fs.promises.writeFile(this.stringsXmlPath, newContent, "utf-8");

      return { path: path.relative(getCwd(), this.stringsXmlPath) };
    } catch (error) {
      throw new Error(`Failed to parse or update strings.xml: ${error}`);
    }
  }
}
