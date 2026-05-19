import fs from "fs";
import path from "path";

import { getCwd } from "@hot-updater/cli-tools";
import { XMLBuilder, XMLParser } from "fast-xml-parser";

import type { ConfigParser } from "./configParser";

interface StringElement {
  "@_name": string;
  "@_moduleConfig"?: string;
  "@_translatable"?: string;
  "#text"?: string;
}

interface ResourcesXml {
  resources: {
    string?: StringElement | StringElement[];
  };
}

interface MetaDataElement {
  "@_android:name": string;
  "@_android:value"?: string;
}

interface ApplicationElement {
  "meta-data"?: MetaDataElement | MetaDataElement[];
}

interface ManifestXml {
  manifest: {
    application?: ApplicationElement | ApplicationElement[];
  };
}

const MANIFEST_KEYS: Record<string, string> = {
  hot_updater_channel: "com.hotupdater.CHANNEL",
  hot_updater_fingerprint_hash: "com.hotupdater.FINGERPRINT_HASH",
  hot_updater_public_key: "com.hotupdater.PUBLIC_KEY",
};

export class AndroidConfigParser implements ConfigParser {
  private androidManifestPaths: string[];
  private stringsXmlPaths: string[];
  private parser: XMLParser;
  private builder: XMLBuilder;

  constructor(customPaths?: string[], androidManifestPaths?: string[]) {
    this.androidManifestPaths = (androidManifestPaths || []).map((p) =>
      path.isAbsolute(p) ? p : path.join(getCwd(), p),
    );

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
    return (
      this.androidManifestPaths.some((path) => fs.existsSync(path)) ||
      this.stringsXmlPaths.some((path) => fs.existsSync(path))
    );
  }

  private getExistingManifestPaths(): string[] {
    return this.androidManifestPaths.filter((path) => fs.existsSync(path));
  }

  private getExistingStringPaths(): string[] {
    return this.stringsXmlPaths.filter((path) => fs.existsSync(path));
  }

  private getManifestKey(key: string): string | undefined {
    return MANIFEST_KEYS[key];
  }

  private getApplication(result: ManifestXml): ApplicationElement | null {
    const application = result.manifest.application;
    if (!application) {
      return null;
    }
    return Array.isArray(application) ? (application[0] ?? null) : application;
  }

  async get(key: string): Promise<{
    value: string | null;
    paths: string[];
  }> {
    const manifestKey = this.getManifestKey(key);
    const existingManifestPaths = this.getExistingManifestPaths();
    const existingStringPaths = this.getExistingStringPaths();
    const searchedPaths: string[] = [];

    if (
      existingManifestPaths.length === 0 &&
      existingStringPaths.length === 0
    ) {
      return {
        value: null,
        paths: [],
      };
    }

    if (manifestKey) {
      for (const androidManifestPath of existingManifestPaths) {
        const relativePath = path.relative(getCwd(), androidManifestPath);
        searchedPaths.push(relativePath);

        try {
          const content = await fs.promises.readFile(
            androidManifestPath,
            "utf-8",
          );
          const result = this.parser.parse(content) as ManifestXml;
          const application = this.getApplication(result);

          if (!application?.["meta-data"]) {
            continue;
          }

          const metaData = Array.isArray(application["meta-data"])
            ? application["meta-data"]
            : [application["meta-data"]];

          const entry = metaData.find(
            (item) => item["@_android:name"] === manifestKey,
          );

          const value = entry?.["@_android:value"];
          if (value) {
            return {
              value: value.trim(),
              paths: searchedPaths,
            };
          }
        } catch (error) {
          throw new Error(`Failed to get ${androidManifestPath}: ${error}`);
        }
      }
    }

    // Check each existing path until we find the key
    for (const stringsXmlPath of existingStringPaths) {
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

  async remove(key: string): Promise<{ paths: string[] }> {
    const manifestKey = this.getManifestKey(key);
    const existingManifestPaths = this.getExistingManifestPaths();
    const existingStringPaths = this.getExistingStringPaths();

    if (
      existingManifestPaths.length === 0 &&
      existingStringPaths.length === 0
    ) {
      return { paths: [] };
    }

    const updatedPaths: string[] = [];

    if (manifestKey) {
      for (const androidManifestPath of existingManifestPaths) {
        try {
          const content = await fs.promises.readFile(
            androidManifestPath,
            "utf-8",
          );
          const result = this.parser.parse(content) as ManifestXml;
          const application = this.getApplication(result);

          if (!application?.["meta-data"]) {
            continue;
          }

          const metaData = Array.isArray(application["meta-data"])
            ? application["meta-data"]
            : [application["meta-data"]];

          const filtered = metaData.filter(
            (item) => item["@_android:name"] !== manifestKey,
          );

          if (filtered.length === metaData.length) {
            continue;
          }

          if (filtered.length === 0) {
            delete application["meta-data"];
          } else {
            application["meta-data"] =
              filtered.length === 1 ? filtered[0] : filtered;
          }

          const newContent = this.builder.build(result);
          await fs.promises.writeFile(androidManifestPath, newContent, "utf-8");
          updatedPaths.push(path.relative(getCwd(), androidManifestPath));
        } catch (error) {
          throw new Error(
            `Failed to remove key from AndroidManifest.xml: ${error}`,
          );
        }
      }
    }

    updatedPaths.push(...(await this.removeStringValue(key)));

    return { paths: updatedPaths };
  }

  private async removeStringValue(key: string): Promise<string[]> {
    const updatedPaths: string[] = [];

    for (const stringsXmlPath of this.getExistingStringPaths()) {
      try {
        const content = await fs.promises.readFile(stringsXmlPath, "utf-8");
        const result = this.parser.parse(content) as ResourcesXml;

        if (!result.resources.string) {
          continue;
        }

        const strings = Array.isArray(result.resources.string)
          ? result.resources.string
          : [result.resources.string];

        const existingIndex = strings.findIndex(
          (str) => str["@_name"] === key && str["@_moduleConfig"] === "true",
        );

        if (existingIndex === -1) {
          continue;
        }

        // Remove the element
        strings.splice(existingIndex, 1);

        // Update the result
        if (strings.length === 0) {
          result.resources.string = undefined;
        } else {
          result.resources.string = strings.length === 1 ? strings[0] : strings;
        }

        const newContent = this.builder.build(result);
        await fs.promises.writeFile(stringsXmlPath, newContent, "utf-8");
        updatedPaths.push(path.relative(getCwd(), stringsXmlPath));
      } catch (error) {
        throw new Error(`Failed to remove key from strings.xml: ${error}`);
      }
    }

    return updatedPaths;
  }

  async set(key: string, value: string): Promise<{ paths: string[] }> {
    const manifestKey = this.getManifestKey(key);

    if (manifestKey) {
      const result = await this.setManifestValue(manifestKey, value);
      if (result.paths.length > 0) {
        const removedPaths = await this.removeStringValue(key);
        return { paths: [...result.paths, ...removedPaths] };
      }
      return this.setStringValue(key, value);
    }

    return this.setStringValue(key, value);
  }

  private async setManifestValue(
    key: string,
    value: string,
  ): Promise<{ paths: string[] }> {
    const existingPaths = this.getExistingManifestPaths();

    if (existingPaths.length === 0) {
      console.warn(
        "hot-updater: No AndroidManifest.xml files found. Skipping Android-specific config modifications.",
      );
      return { paths: [] };
    }

    const updatedPaths: string[] = [];

    for (const androidManifestPath of existingPaths) {
      try {
        const content = await fs.promises.readFile(
          androidManifestPath,
          "utf-8",
        );
        const result = this.parser.parse(content) as ManifestXml;
        const application = this.getApplication(result);

        if (!application) {
          continue;
        }

        if (!application["meta-data"]) {
          application["meta-data"] = [];
        }

        const metaData = Array.isArray(application["meta-data"])
          ? application["meta-data"]
          : [application["meta-data"]];

        const existingIndex = metaData.findIndex(
          (item) => item["@_android:name"] === key,
        );

        const metaDataElement: MetaDataElement = {
          "@_android:name": key,
          "@_android:value": value,
        };

        if (existingIndex !== -1) {
          metaData[existingIndex] = metaDataElement;
        } else {
          metaData.push(metaDataElement);
        }

        application["meta-data"] =
          metaData.length === 1 ? metaData[0] : metaData;

        const newContent = this.builder.build(result);
        await fs.promises.writeFile(androidManifestPath, newContent, "utf-8");
        updatedPaths.push(path.relative(getCwd(), androidManifestPath));
      } catch (error) {
        throw new Error(
          `Failed to parse or update AndroidManifest.xml: ${error}`,
        );
      }
    }

    return {
      paths: updatedPaths,
    };
  }

  private async setStringValue(
    key: string,
    value: string,
  ): Promise<{ paths: string[] }> {
    const existingPaths = this.getExistingStringPaths();

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
          "@_translatable": "false",
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
