import fs from "node:fs";
import path from "node:path";

import fg from "fast-glob";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "../../..");

// The provider init flows and the CLI print these docs links for users.
const SOURCES = [
  "plugins/*/iac/*.ts",
  "packages/hot-updater/src/**/*.ts",
  "packages/cli-tools/src/**/*.ts",
];
const DOCS_LINK =
  /https:\/\/hot-updater\.dev\/docs(?:\/[\w-]+)+\/?(?:#[\w-]+)?/g;

type DocsPage = { url: string; data: { anchors: string[] } };

// Read anchors with the docs site's own parser so they match the heading ids
// Fumadocs generates. Load it by path: the docs are not a dependency of this
// package, and a static import would add them to its tsc program and Nx graph.
const readDocsPages = async (): Promise<DocsPage[]> => {
  const { readDocumentation } = await import(
    path.join(repoRoot, "docs/plugins/docs-content.ts")
  );
  return readDocumentation(
    path.join(repoRoot, "docs/content/docs/(latest)"),
  ).source.getPages();
};

const findDocsLinks = () =>
  fg
    .globSync(SOURCES, { cwd: repoRoot })
    .sort()
    .flatMap((file) =>
      fs
        .readFileSync(path.join(repoRoot, file), "utf-8")
        .split("\n")
        .flatMap((line, index) =>
          Array.from(line.matchAll(DOCS_LINK), ([url]) => ({
            file,
            location: `${file}:${index + 1}`,
            url,
          })),
        ),
    );

describe("CLI docs links", () => {
  it("include the next-step link of every managed provider init flow", () => {
    const files = findDocsLinks()
      .filter(({ url }) => url.includes("#"))
      .map(({ file }) => file);

    expect(files).toEqual(
      expect.arrayContaining([
        "plugins/aws/iac/index.ts",
        "plugins/cloudflare/iac/index.ts",
        "plugins/firebase/iac/index.ts",
        "plugins/supabase/iac/index.ts",
      ]),
    );
  });

  it("point at an existing docs page and heading", async () => {
    const anchorsByPage = new Map(
      (await readDocsPages()).map((page) => [page.url, page.data.anchors]),
    );

    const issues = findDocsLinks().flatMap(({ location, url }) => {
      const { hash, pathname } = new URL(url);
      const anchors = anchorsByPage.get(pathname.replace(/\/$/, ""));
      if (!anchors) return [`${location}: missing page ${url}`];
      if (hash && !anchors.includes(hash.slice(1))) {
        return [`${location}: missing anchor ${url}`];
      }
      return [];
    });

    expect(issues).toEqual([]);
  });
});
