// @vitest-environment node

import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "../../../..");

const collectProductFiles = async (directory: string): Promise<string[]> => {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) return collectProductFiles(path);
      if (!/\.tsx?$/.test(entry.name) || /\.spec\.tsx?$/.test(entry.name)) {
        return [];
      }
      return [path];
    }),
  );
  return nested.flat();
};

describe("analytics static guards", () => {
  it("contains no provider identity capability branch", async () => {
    // Given
    const files = await collectProductFiles(
      resolve(repositoryRoot, "packages/console/src"),
    );

    // When
    const sources = await Promise.all(
      files.map((file) => readFile(file, "utf8")),
    );

    // Then
    const providerIdentityPattern = new RegExp(
      ["s3", "Database|adapter", "Name|database\\s*\\.\\s*name"].join(""),
    );
    expect(sources.join("\n")).not.toMatch(providerIdentityPattern);
  });

  it("uses bundle-event analytics terminology in product narratives", async () => {
    // Given
    const files = [
      ...(await collectProductFiles(
        resolve(repositoryRoot, "packages/console/src"),
      )),
      ...[
        "README.md",
        "docs/content/docs/guides/console.mdx",
        "docs/content/docs/database-plugins/custom-database.mdx",
        "docs/content/docs/custom/database/s3.mdx",
        "docs/content/docs/react-native-api/init.mdx",
      ].map((file) => resolve(repositoryRoot, file)),
    ];

    // When
    const sources = await Promise.all(
      files.map((file) => readFile(file, "utf8")),
    );

    // Then
    const oldDomainTerm = ["trans", "ition"].join("");
    const terminologyPattern = new RegExp(
      [
        `ota ${oldDomainTerm}s`,
        `${oldDomainTerm} analytics`,
        `${oldDomainTerm} activity`,
        `${oldDomainTerm}-event`,
        `${oldDomainTerm} events`,
        `${oldDomainTerm} history`,
        `append-only ${oldDomainTerm}`,
      ].join("|"),
      "i",
    );
    expect(sources.join("\n")).not.toMatch(terminologyPattern);
  });
});
