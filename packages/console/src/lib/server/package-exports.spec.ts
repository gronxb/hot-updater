// @vitest-environment node

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

type PackEntry = {
  readonly files: readonly { readonly path: string }[];
};

type PackageJson = {
  readonly exports: {
    readonly "./embedded": {
      readonly types: string;
      readonly default: string;
    };
    readonly "./hosted": {
      readonly types: string;
      readonly default: string;
    };
  };
};

const parseJson = (value: string): unknown => JSON.parse(value);

const isPackEntry = (value: unknown): value is PackEntry =>
  typeof value === "object" &&
  value !== null &&
  "files" in value &&
  Array.isArray(value.files) &&
  value.files.every(
    (file) =>
      typeof file === "object" &&
      file !== null &&
      "path" in file &&
      typeof file.path === "string",
  );

const parsePackEntries = (output: string): readonly PackEntry[] => {
  const value = parseJson(output);

  if (!Array.isArray(value) || !value.every(isPackEntry)) {
    throw new TypeError("npm pack output did not match the expected schema");
  }

  return value;
};

const isPackageJson = (value: unknown): value is PackageJson => {
  if (typeof value !== "object" || value === null || !("exports" in value)) {
    return false;
  }

  const exports = value.exports;
  if (typeof exports !== "object" || exports === null) {
    return false;
  }

  if (!("./embedded" in exports) || !("./hosted" in exports)) {
    return false;
  }

  const embedded = exports["./embedded"];
  const hosted = exports["./hosted"];

  return (
    typeof embedded === "object" &&
    embedded !== null &&
    "types" in embedded &&
    "default" in embedded &&
    typeof embedded.types === "string" &&
    typeof embedded.default === "string" &&
    typeof hosted === "object" &&
    hosted !== null &&
    "types" in hosted &&
    "default" in hosted &&
    typeof hosted.types === "string" &&
    typeof hosted.default === "string"
  );
};

const readPackageJson = (): PackageJson => {
  const value = parseJson(readFileSync("package.json", "utf8"));

  if (!isPackageJson(value)) {
    throw new TypeError(
      "package.json exports did not match the expected schema",
    );
  }

  return value;
};

describe("console package exports", () => {
  it("exports built embedded and hosted entrypoints instead of raw source", async () => {
    execFileSync("pnpm", ["run", "build:exports"], {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: "pipe",
    });

    const output = execFileSync("npm", ["pack", "--dry-run", "--json"], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    const [pack] = parsePackEntries(output);
    const packedFiles = new Set(pack.files.map((file) => file.path));
    const packageJson = readPackageJson();

    expect(packageJson.exports["./embedded"]).toEqual({
      default: "./dist/embedded.mjs",
      types: "./dist/embedded.d.ts",
    });
    expect(packageJson.exports["./hosted"]).toEqual({
      default: "./dist/hosted.mjs",
      types: "./dist/hosted.d.ts",
    });
    expect(packedFiles).toContain("dist/embedded.mjs");
    expect(packedFiles).toContain("dist/embedded.d.ts");
    expect(packedFiles).toContain("dist/hosted.mjs");
    expect(packedFiles).toContain("dist/hosted.d.ts");
    expect(packedFiles).not.toContain("src/embedded.tsx");
    expect(packedFiles).not.toContain("src/lib/server/hosted.server.ts");

    for (const artifact of [
      "dist/embedded.mjs",
      "dist/embedded.d.ts",
      "dist/hosted.mjs",
      "dist/hosted.d.ts",
    ]) {
      expect(readFileSync(artifact, "utf8")).not.toContain("@/");
    }

    await expect(
      import(pathToFileURL("dist/embedded.mjs").href),
    ).resolves.toHaveProperty("HotUpdaterConsole");
    await expect(
      import(pathToFileURL("dist/hosted.mjs").href),
    ).resolves.toHaveProperty("getConfigOperation");
  }, 15_000);
});
