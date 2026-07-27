import {
  createAwsLambdaHarness,
  createAwsNodeHarness,
  createCloudflareNodeHarness,
  isR2Module,
  isS3Module,
  observeS3Entry,
} from "./providerMatrixS3Entry";
import type { ProviderMatrixObservation } from "./providerMatrixTypes";

export const observeS3Matrix = async (): Promise<
  readonly ProviderMatrixObservation[]
> => {
  const awsNodeUrl = new URL(
    "../../plugins/aws/src/storage/node.ts",
    import.meta.url,
  ).href;
  const awsLambdaUrl = new URL(
    "../../plugins/aws/src/storage/lambda.ts",
    import.meta.url,
  ).href;
  const cloudflareNodeUrl = new URL(
    "../../plugins/cloudflare/src/storage/node.ts",
    import.meta.url,
  ).href;
  const [awsNodeModule, awsLambdaModule, cloudflareNodeModule]: unknown[] =
    await Promise.all([
      import(awsNodeUrl),
      import(awsLambdaUrl),
      import(cloudflareNodeUrl),
    ]);
  if (
    !isS3Module(awsNodeModule) ||
    !isS3Module(awsLambdaModule) ||
    !isR2Module(cloudflareNodeModule)
  ) {
    throw new TypeError("S3-compatible public storage entry is invalid.");
  }
  const harnesses = [
    createAwsNodeHarness(awsNodeModule),
    createAwsLambdaHarness(awsLambdaModule),
    createCloudflareNodeHarness(cloudflareNodeModule),
  ] as const;
  const observations: ProviderMatrixObservation[] = [];
  for (const harness of harnesses) {
    observations.push(await observeS3Entry(harness));
  }
  return observations;
};
