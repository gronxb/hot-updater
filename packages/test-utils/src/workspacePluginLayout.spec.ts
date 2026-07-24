import { readdir } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

const workspaceRoot = path.resolve(import.meta.dirname, "../../..");

describe("workspace plugin layout", () => {
  it("keeps every direct plugins entry as a package directory", async () => {
    const pluginEntries = await readdir(path.join(workspaceRoot, "plugins"), {
      withFileTypes: true,
    });

    const nonPackageEntries = pluginEntries
      .filter((entry) => !entry.isDirectory())
      .map((entry) => entry.name);

    expect(nonPackageEntries).toEqual([]);
  });
});
