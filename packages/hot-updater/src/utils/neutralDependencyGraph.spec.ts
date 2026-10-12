import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { expect, it } from "vitest";

it("installs the common CLI without a transitive application integration", async () => {
  const root = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../../..",
  );
  const manifests = new Map<string, Record<string, string>>();
  for (const parent of ["packages", "plugins"]) {
    for (const entry of await fs.readdir(path.join(root, parent), {
      withFileTypes: true,
    })) {
      if (!entry.isDirectory()) continue;
      const manifest = path.join(root, parent, entry.name, "package.json");
      const contents = await fs
        .readFile(manifest, "utf8")
        .catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return null;
          throw error;
        });
      if (contents === null) continue;
      const value = JSON.parse(contents);
      manifests.set(value.name, value.dependencies ?? {});
    }
  }
  const pending = [["hot-updater"]];
  const visited = new Set<string>();
  const violations: string[] = [];
  while (pending.length > 0) {
    const chain = pending.pop()!;
    const name = chain.at(-1)!;
    if (visited.has(name)) continue;
    visited.add(name);
    if (
      /^(?:@hot-updater\/(?:react-native|expo|lynx)|react-native|expo|@expo\/fingerprint)$/.test(
        name,
      )
    ) {
      violations.push(chain.join(" -> "));
    }
    for (const dependency of Object.keys(manifests.get(name) ?? {})) {
      pending.push([...chain, dependency]);
    }
  }
  expect(violations).toEqual([]);
});
