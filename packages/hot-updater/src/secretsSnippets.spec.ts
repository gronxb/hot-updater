import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

import type { SecretsAdapter } from "@hot-updater/plugin-core";
import { describe, expect, it } from "vitest";

const packageRoot = path.resolve(import.meta.dirname, "..");
const pagesDir = path.resolve(
  packageRoot,
  "../../docs/content/docs/(latest)/guides/secrets-adapters",
);

// The secrets adapters the docs give as files to paste, each type-checked
// with the vendor's SDK against hot-updater's own SecretsAdapter.
const SNIPPETS = [
  "secrets/1password.ts",
  "secrets/bitwarden.ts",
  "secrets/dotenvx.ts",
];

const FENCE = /^```ts title="(secrets\/[\w-]+\.ts)"\n([\s\S]*?)^```$/gmu;

const readSnippets = () =>
  fs
    .readdirSync(pagesDir)
    .filter((file) => file.endsWith(".mdx"))
    .flatMap((file) =>
      Array.from(
        fs.readFileSync(path.join(pagesDir, file), "utf-8").matchAll(FENCE),
        ([, title, code]) => ({ page: file, title: title!, code: code! }),
      ),
    );

/**
 * Type-checks `files` with this package's `tsc`, in a directory under this
 * package so the vendor SDKs resolve from its devDependencies, with
 * `hot-updater` as this package's root. Returns each file's errors.
 */
const typeCheck = (files: Readonly<Record<string, string>>) => {
  const root = fs.mkdtempSync(path.join(packageRoot, ".snippets-"));
  try {
    for (const [name, code] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
      fs.writeFileSync(path.join(root, name), code);
    }
    fs.writeFileSync(
      path.join(root, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          module: "ESNext",
          moduleResolution: "Bundler",
          target: "ES2022",
          lib: ["ES2023"],
          types: ["node"],
          strict: true,
          noUnusedLocals: true,
          skipLibCheck: true,
          noEmit: true,
          paths: { "hot-updater": ["../src/config.ts"] },
        },
        files: Object.keys(files),
      }),
    );
    // The compiler `pnpm test:type` runs, whatever its bin is named.
    const manifest = createRequire(
      path.join(packageRoot, "package.json"),
    ).resolve("typescript/package.json");
    const { bin } = JSON.parse(fs.readFileSync(manifest, "utf-8")) as {
      bin: Record<string, string>;
    };
    const tsc = path.join(path.dirname(manifest), Object.values(bin)[0]!);
    const { stdout } = spawnSync(
      process.execPath,
      [tsc, "-p", root, "--pretty", "false"],
      { cwd: root, encoding: "utf-8" },
    );
    // Only the snippets' errors: the package's own sources are its tsc's.
    const errors = stdout
      .split(/\n(?=\S)/u)
      .map((line) => /^(.+?)\((\d+),\d+\): error (.*)$/su.exec(line.trim()))
      .filter((match) => match !== null);
    // Errors of no file, such as a bad option, would hide every other.
    const general = stdout
      .split("\n")
      .filter((line) => line.startsWith("error "));
    return Object.fromEntries([
      ["tsc", general],
      ...Object.keys(files).map((name) => [
        name,
        errors
          .filter(([, file]) => file === name)
          .map(([, , line, message]) => `${line}: ${message}`),
      ]),
    ]);
  } finally {
    fs.rmSync(root, { force: true, recursive: true });
  }
};

/**
 * A file that fails to type-check unless every snippet exports at least one
 * function and every function it exports returns a `SecretsAdapter`.
 */
const factoryCheck = (titles: readonly string[]) =>
  [
    'import type { SecretsAdapter } from "hot-updater";',
    "type Factories<M> = [keyof M] extends [never]",
    "  ? false",
    "  : M[keyof M] extends (...args: never[]) => SecretsAdapter",
    "    ? true",
    "    : false;",
    ...titles.flatMap((title, index) => [
      `import * as snippet${index} from "./${title.replace(/\.ts$/u, "")}";`,
      `export const check${index}: Factories<typeof snippet${index}> = true;`,
    ]),
  ].join("\n");

describe("secrets adapter snippets in the docs", () => {
  const snippets = readSnippets();

  it("gives one file for each store", () => {
    expect(snippets.map(({ title }) => title).sort()).toEqual(SNIPPETS);
  });

  it("type-check against hot-updater's SecretsAdapter and each vendor's SDK", () => {
    const titles = snippets.map(({ title }) => title);
    const diagnostics = typeCheck({
      ...Object.fromEntries(snippets.map(({ title, code }) => [title, code])),
      "check.ts": factoryCheck(titles),
    });

    expect(diagnostics).toEqual(
      Object.fromEntries(
        ["tsc", ...titles, "check.ts"].map((title) => [title, []]),
      ),
    );
  }, 60_000);

  it("dotenvx() stores encrypted values in its own file, reads them back, and never touches .env.hotupdater", async () => {
    const snippet = snippets.find(
      ({ title }) => title === "secrets/dotenvx.ts",
    );
    // Under this package, so the snippet's imports resolve from its
    // devDependencies.
    const module = fs.mkdtempSync(path.join(packageRoot, ".snippet-"));
    const project = fs.mkdtempSync(
      path.join(os.tmpdir(), "hot-updater-dotenvx-"),
    );
    try {
      fs.writeFileSync(path.join(module, "dotenvx.ts"), snippet!.code);
      const { dotenvx } = (await import(path.join(module, "dotenvx.ts"))) as {
        dotenvx: (options?: { path?: string }) => SecretsAdapter;
      };
      const secrets = dotenvx();
      const value = '{"keyId":"ABC123","p8":"-----BEGIN PRIVATE KEY-----"}';

      await secrets.set!("asc-api-key", value, { cwd: project });

      const file = fs.readFileSync(
        path.join(project, "hot-updater.secrets.env"),
        "utf-8",
      );
      expect(file).toMatch(/^HOT_UPDATER_ASC_API_KEY="encrypted:/mu);
      expect(file).not.toContain("ABC123");
      expect(fs.existsSync(path.join(project, ".env.keys"))).toBe(true);
      expect(
        await secrets.get(["asc-api-key", "play-service-account"], {
          cwd: project,
        }),
      ).toEqual({ "asc-api-key": value, "play-service-account": undefined });
      expect(fs.existsSync(path.join(project, ".env.hotupdater"))).toBe(false);

      const refused = dotenvx({ path: ".env.hotupdater" });
      await expect(
        refused.set!("asc-api-key", value, { cwd: project }),
      ).rejects.toThrow("dotenvx() keeps its own file, not .env.hotupdater.");
      await expect(
        refused.get(["asc-api-key"], { cwd: project }),
      ).rejects.toThrow("dotenvx() keeps its own file, not .env.hotupdater.");
      expect(fs.existsSync(path.join(project, ".env.hotupdater"))).toBe(false);
    } finally {
      fs.rmSync(module, { force: true, recursive: true });
      fs.rmSync(project, { force: true, recursive: true });
    }
  }, 60_000);
});
