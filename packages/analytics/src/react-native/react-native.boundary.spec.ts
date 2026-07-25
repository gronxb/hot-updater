import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

const reactNativeSourceFiles = [
  path.join(import.meta.dirname, "index.ts"),
  path.join(import.meta.dirname, "transport.ts"),
];

describe("React Native Analytics package boundary", () => {
  it("does not pull server or Node runtime modules into the mobile entry", async () => {
    const source = (
      await Promise.all(
        reactNativeSourceFiles.map((file) => readFile(file, "utf8")),
      )
    ).join("\n");

    expect(source).not.toMatch(
      /@hot-updater\/(?:plugin-core|server)|from ["']\.\.\/index["']|node:/,
    );
  });
});
