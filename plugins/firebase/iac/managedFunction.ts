import fs from "fs/promises";
import path from "path";

import { bundleServer } from "@hot-updater/cli-tools";

/**
 * The managed Cloud Function with the project's server definition: an entry
 * that serves the definition's client routes, bundled into
 * `functionsDir/index.cjs` in place of the prebuilt function. In the
 * function, `@hot-updater/firebase` is its runtime module, whose database
 * and storage are the function's own project and default bucket. The
 * Firebase SDKs stay external: the function installs them, as it does for
 * the prebuilt function.
 */
export const buildFunctionFromDefinition = async ({
  definition,
  packageRoot,
  functionsDir,
}: {
  /** The server definition's absolute path. */
  definition: string;
  packageRoot: string;
  functionsDir: string;
}) => {
  const runtime = path.join(packageRoot, "dist", "managed.mjs");
  const entry = path.join(functionsDir, "managed.ts");
  await fs.writeFile(
    entry,
    [
      `import { serveManagedFunction } from ${JSON.stringify(runtime)};`,
      `import { hotUpdater } from ${JSON.stringify(definition)};`,
      "",
      "export const hot = serveManagedFunction(hotUpdater);",
      "",
    ].join("\n"),
  );
  try {
    return await bundleServer({
      input: entry,
      outfile: path.join(functionsDir, "index.cjs"),
      format: "cjs",
      platform: "node",
      external: [
        "firebase-admin",
        "firebase-admin/*",
        "firebase-functions",
        "firebase-functions/*",
      ],
      alias: { "@hot-updater/firebase": runtime },
      target: "the Firebase Cloud Function",
    });
  } finally {
    await fs.rm(entry, { force: true });
  }
};
