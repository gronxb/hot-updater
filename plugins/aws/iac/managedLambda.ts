import fs from "fs/promises";
import path from "path";

import { bundleServer } from "@hot-updater/cli-tools";

/**
 * The managed Lambda@Edge function with the project's server definition: an
 * entry that serves the definition's client routes, bundled into
 * `lambdaDir/index.cjs`. In the function, `@hot-updater/aws` is its runtime
 * module, whose database and storage are the table and bucket init set up.
 * The AWS SDK stays external, since the Lambda runtime provides it, as it
 * does for the prebuilt function.
 */
export const buildLambdaFromDefinition = async ({
  definition,
  packageRoot,
  lambdaDir,
}: {
  /** The server definition's absolute path. */
  definition: string;
  packageRoot: string;
  lambdaDir: string;
}) => {
  const runtime = path.join(packageRoot, "dist", "managed.mjs");
  const entry = path.join(lambdaDir, "managed.ts");
  await fs.writeFile(
    entry,
    [
      `import { serveManagedLambda } from ${JSON.stringify(runtime)};`,
      `import { hotUpdater } from ${JSON.stringify(definition)};`,
      "",
      "export const handler = serveManagedLambda(hotUpdater);",
      "",
    ].join("\n"),
  );
  try {
    return await bundleServer({
      input: entry,
      outfile: path.join(lambdaDir, "index.cjs"),
      format: "cjs",
      platform: "node",
      external: ["@aws-sdk/*"],
      alias: { "@hot-updater/aws": runtime },
      target: "the AWS Lambda@Edge function",
    });
  } finally {
    await fs.rm(entry, { force: true });
  }
};
