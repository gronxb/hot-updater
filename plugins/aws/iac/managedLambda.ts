import fs from "fs/promises";
import path from "path";

import { bundleServer } from "@hot-updater/cli-tools";

/**
 * The AWS SDK packages the function takes from the Lambda runtime, as the
 * prebuilt function does, and the credential providers the definition init
 * writes imports. Any other, such as a client a plugin brings, is bundled at
 * the version the project installed.
 */
export const LAMBDA_RUNTIME_PACKAGES = [
  "@aws-sdk/client-cloudfront",
  "@aws-sdk/client-dynamodb",
  "@aws-sdk/client-s3",
  "@aws-sdk/client-ssm",
  "@aws-sdk/cloudfront-signer",
  "@aws-sdk/lib-dynamodb",
  "@aws-sdk/lib-storage",
  "@aws-sdk/credential-provider-sso",
  "@aws-sdk/credential-providers",
];

/**
 * The managed Lambda@Edge function with the project's server definition: an
 * entry that serves the definition's client routes, bundled into
 * `lambdaDir/index.cjs`. In the function, `@hot-updater/aws` is its runtime
 * module, whose database and storage are the table and bucket init set up.
 * The AWS SDK packages the Lambda runtime provides stay external, as they do
 * for the prebuilt function.
 */
export const buildLambdaFromDefinition = async ({
  definition,
  packageRoot,
  projectRoot = process.cwd(),
  lambdaDir,
}: {
  /** The server definition's absolute path. */
  definition: string;
  packageRoot: string;
  /** The project's directory, which the bundle's paths are relative to. */
  projectRoot?: string;
  lambdaDir: string;
}) => {
  const runtime = path.join(packageRoot, "dist", "managed.mjs");
  const entry = path.join(lambdaDir, "managed.ts");
  await fs.writeFile(
    entry,
    [
      `import { serveManagedLambda } from ${JSON.stringify(runtime)};`,
      `import * as definition from ${JSON.stringify(definition)};`,
      "",
      // The export the CLI reads: `hotUpdater`, or the default export.
      "export const handler = serveManagedLambda(definition.hotUpdater ?? definition.default);",
      "",
    ].join("\n"),
  );
  try {
    return await bundleServer({
      input: entry,
      definition,
      projectRoot,
      outfile: path.join(lambdaDir, "index.cjs"),
      format: "cjs",
      platform: "node",
      external: LAMBDA_RUNTIME_PACKAGES.flatMap((name) => [name, `${name}/*`]),
      alias: { "@hot-updater/aws": runtime },
      target: "the AWS Lambda@Edge function",
    });
  } finally {
    await fs.rm(entry, { force: true });
  }
};
