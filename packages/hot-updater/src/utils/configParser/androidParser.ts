import fs from "fs";
import path from "path";

import { getCwd } from "@hot-updater/cli-tools";
import { XMLBuilder, XMLParser } from "fast-xml-parser";

import type { ConfigParser } from "./configParser";

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
  private parser: XMLParser;
  private builder: XMLBuilder;

  constructor(androidManifestPaths?: string[]) {
    this.androidManifestPaths = (androidManifestPaths || []).map((p) =>
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
    return this.getExistingManifestPaths().length > 0;
  }

  private getExistingManifestPaths(): string[] {
    return this.androidManifestPaths.filter((filePath) =>
      fs.existsSync(filePath),
    );
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
    const searchedPaths: string[] = [];

    if (!manifestKey || existingManifestPaths.length === 0) {
      return {
        value: null,
        paths: [],
      };
    }

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

    return {
      value: null,
      paths: searchedPaths,
    };
  }

  async remove(key: string): Promise<{ paths: string[] }> {
    const manifestKey = this.getManifestKey(key);
    const existingManifestPaths = this.getExistingManifestPaths();

    if (!manifestKey || existingManifestPaths.length === 0) {
      return { paths: [] };
    }

    const updatedPaths: string[] = [];

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

        application["meta-data"] =
          filtered.length === 0
            ? undefined
            : filtered.length === 1
              ? filtered[0]
              : filtered;

        const newContent = this.builder.build(result);
        await fs.promises.writeFile(androidManifestPath, newContent, "utf-8");
        updatedPaths.push(path.relative(getCwd(), androidManifestPath));
      } catch (error) {
        throw new Error(
          `Failed to remove key from AndroidManifest.xml: ${error}`,
        );
      }
    }

    return { paths: updatedPaths };
  }

  async set(key: string, value: string): Promise<{ paths: string[] }> {
    const manifestKey = this.getManifestKey(key);
    if (!manifestKey) {
      return { paths: [] };
    }
    return this.setManifestValue(manifestKey, value);
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
}
