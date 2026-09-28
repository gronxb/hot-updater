import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

import { expect, it } from "vitest";

it("loads the public server entrypoints without optional database drivers", () => {
  const loader = `
    export async function resolve(specifier, context, nextResolve) {
      if (/^(kysely|drizzle-orm|mongodb|@prisma\\/client)(\\/|$)/.test(specifier)) {
        throw new Error('Optional database driver requested: ' + specifier);
      }
      return nextResolve(specifier, context);
    }
  `;
  const entrypoint = (name: string) =>
    pathToFileURL(`${import.meta.dirname}/../dist/${name}.mjs`).href;
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `
        import { register } from 'node:module';
        register(${JSON.stringify(`data:text/javascript,${encodeURIComponent(loader)}`)});
        const server = await import(${JSON.stringify(entrypoint("index"))});
        const node = await import(${JSON.stringify(entrypoint("node"))});
        const db = await import(${JSON.stringify(entrypoint("db/index"))});
        if (typeof server.createHotUpdater !== 'function' ||
            typeof node.toNodeHandler !== 'function' ||
            typeof db.createBundleDiff !== 'function') {
          throw new Error('Missing public entrypoint exports');
        }
      `,
    ],
    { encoding: "utf8", timeout: 15_000 },
  );
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
});
