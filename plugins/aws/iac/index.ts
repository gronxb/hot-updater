import {
  colors,
  confirmInitInputPersistence,
  ensureInstallPackages,
  getHotUpdaterInitInputEnv,
  getInitProviderEnvVars,
  getInitProviderTextPromptValues,
  link,
  makeEnv,
  p,
  readHotUpdaterInitEnv,
  type RunInitOptions,
  shouldAutoSelectOnlyInitResource,
  transformTemplate,
  writeHotUpdaterConfig,
} from "@hot-updater/cli-tools";
import { execa } from "execa";

import { resolveAwsAuth } from "./awsAuth";
import {
  assertAwsNonInteractiveInputs,
  resolveAwsInitInputs,
} from "./awsInitInputs";
import { CloudFrontManager } from "./cloudfront";
import { IAMManager } from "./iam";
import { initProvider as AWS_INIT_PROVIDER } from "./init/index";
import { LambdaEdgeDeployer } from "./lambdaEdge";
import { Migration0001HotUpdater0_13_0 } from "./migrations/Migration0001HotUpdater0_13_0";
import { Migration0001HotUpdater0_18_0 } from "./migrations/Migration0001HotUpdater0_18_0";
import { type AwsRegion, regionLocationMap } from "./regionLocationMap";
import { S3Manager } from "./s3";
import { SSMKeyPairManager } from "./ssm";
import { getConfigScaffold, SOURCE_TEMPLATE } from "./templates";

const checkIfAwsCliInstalled = async () => {
  try {
    await execa("aws", ["--version"]);
    return true;
  } catch {
    return false;
  }
};

const isAwsRegion = (value: string | undefined): value is AwsRegion => {
  return value !== undefined && Object.hasOwn(regionLocationMap, value);
};

export const runInit = async ({ build, envFile }: RunInitOptions) => {
  const nonInteractive = envFile !== undefined;
  const initEnvSources = await readHotUpdaterInitEnv(process.cwd(), envFile);
  const { managedEnv } = initEnvSources;
  const providerEnv = getHotUpdaterInitInputEnv(initEnvSources, nonInteractive);
  const savedInputs = resolveAwsInitInputs(providerEnv);
  assertAwsNonInteractiveInputs(savedInputs, nonInteractive);

  const isAwsCliInstalled = await checkIfAwsCliInstalled();
  if (!isAwsCliInstalled) {
    p.log.error(
      `AWS CLI is not installed. Please visit ${link("https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html")} for installation instructions`,
    );
    process.exit(1);
  }

  p.log.message(colors.blue("The following permissions are required:"));
  p.log.message(
    `${colors.blue("AmazonS3FullAccess")}: Create and read S3 buckets`,
  );
  p.log.message(
    `${colors.blue("AWSLambda_FullAccess")}: Create and update Lambda functions`,
  );
  p.log.message(
    `${colors.blue("CloudFrontFullAccess")}: Create and update CloudFront distributions`,
  );
  p.log.message(
    `${colors.blue("IAMFullAccess")}: Get or create IAM roles for Lambda@Edge`,
  );
  p.log.message(
    `${colors.blue("AmazonSSMFullAccess")}: Access to SSM Parameters for storing CloudFront key pairs`,
  );

  const { awsProfile, configAuthMode, credentials, mode } =
    await resolveAwsAuth(providerEnv, nonInteractive);
  const resolvedAuthInputs = {
    ...savedInputs,
    accessKeyId:
      mode === "account" ? credentials.accessKeyId : savedInputs.accessKeyId,
    authMode: mode,
    profile: awsProfile ?? undefined,
    secretAccessKey:
      mode === "account"
        ? credentials.secretAccessKey
        : savedInputs.secretAccessKey,
  };

  // S3 related tasks: Create S3Manager instance
  const s3Manager = new S3Manager(credentials);
  let availableBuckets: { name: string; region: AwsRegion }[] = [];
  try {
    await p.tasks([
      {
        title: "Checking S3 Buckets...",
        task: async () => {
          availableBuckets = await s3Manager.listBuckets();
        },
      },
    ]);
  } catch (e) {
    if (e instanceof Error) p.log.error(e.message);
    throw e;
  }

  const createKey = `create/${Math.random().toString(36).substring(2, 15)}`;
  const savedBucketName = savedInputs.bucketName;
  const savedBucketRegion = savedInputs.bucketRegion;
  const existingBucket = availableBuckets.find(
    (bucket) => bucket.name === savedBucketName,
  );
  const createSavedBucket =
    nonInteractive &&
    savedBucketName !== undefined &&
    isAwsRegion(savedBucketRegion) &&
    !existingBucket;
  if (savedBucketName && !existingBucket && !createSavedBucket) {
    p.log.warn("Saved S3 bucket was not found. Select a bucket again.");
  }
  const savedLambdaName = savedInputs.lambdaName;
  const resourceInputs = await p.group<{
    bucketSelection: string | symbol;
    bucketName: string | symbol | undefined;
    bucketRegion: string | symbol | undefined;
    lambdaName: string | symbol;
  }>(
    {
      bucketSelection: () => {
        if (existingBucket) {
          return Promise.resolve(existingBucket.name);
        }
        if (createSavedBucket) {
          return Promise.resolve(createKey);
        }
        if (
          shouldAutoSelectOnlyInitResource({
            availableResourceCount: availableBuckets.length,
            savedIdentifier: savedBucketName,
          }) &&
          availableBuckets[0]
        ) {
          return Promise.resolve(availableBuckets[0].name);
        }
        return p.select<string>({
          message: "S3 Bucket List",
          options: [
            ...availableBuckets.map((bucket) => ({
              value: bucket.name,
              label: `${bucket.name} (${bucket.region})`,
            })),
            { value: createKey, label: "Create New S3 Bucket" },
          ],
        });
      },
      bucketName: ({ results }) =>
        results.bucketSelection === createKey
          ? createSavedBucket
            ? Promise.resolve(savedBucketName)
            : p.text({
                ...getInitProviderTextPromptValues(
                  AWS_INIT_PROVIDER.inputs.bucketName.prompt,
                  savedBucketName,
                ),
                message: AWS_INIT_PROVIDER.inputs.bucketName.prompt.message,
                validate: (value) =>
                  value ? undefined : "S3 bucket name is required",
              })
          : Promise.resolve(results.bucketSelection),
      bucketRegion: ({ results }) =>
        results.bucketSelection === createKey
          ? createSavedBucket
            ? Promise.resolve(savedBucketRegion)
            : p.select({
                message: AWS_INIT_PROVIDER.inputs.bucketRegion.prompt.message,
                options: Object.entries(regionLocationMap).map(
                  ([region, location]) => ({
                    label: `${region} (${location})`,
                    value: region,
                  }),
                ),
              })
          : Promise.resolve(
              availableBuckets.find(
                (bucket) => bucket.name === results.bucketSelection,
              )?.region,
            ),
      lambdaName: () =>
        nonInteractive && savedLambdaName
          ? Promise.resolve(savedLambdaName)
          : p.text({
              ...getInitProviderTextPromptValues(
                AWS_INIT_PROVIDER.inputs.lambdaName.prompt,
                savedLambdaName,
              ),
              message: AWS_INIT_PROVIDER.inputs.lambdaName.prompt.message,
              validate: (value) =>
                value ? undefined : "Lambda function name is required",
            }),
    },
    {
      onCancel: () => process.exit(1),
    },
  );
  const { bucketName, bucketRegion, lambdaName } = resourceInputs;
  if (!bucketName || !lambdaName) {
    p.log.error("AWS resource names are required.");
    process.exit(1);
  }

  if (!isAwsRegion(bucketRegion)) {
    p.log.error("AWS bucket region is required.");
    process.exit(1);
  }
  const cloudFrontManager = new CloudFrontManager(bucketRegion, credentials);
  const selectedDistribution = await cloudFrontManager.selectDistribution({
    bucketName,
    distributionId: savedInputs.distributionId,
    nonInteractive,
  });
  const resolvedInputs = {
    ...resolvedAuthInputs,
    bucketName,
    bucketRegion,
    distributionId: selectedDistribution?.Id,
    lambdaName,
    migrationApproved: savedInputs.migrationApproved,
  };
  const persistCredentialInputs = await confirmInitInputPersistence({
    existingEnv: managedEnv,
    inputs: resolvedInputs,
    nonInteractive,
    provider: AWS_INIT_PROVIDER,
  });
  const initEnv = getInitProviderEnvVars({
    includeConsentInputs: persistCredentialInputs,
    inputs: resolvedInputs,
    provider: AWS_INIT_PROVIDER,
  });
  const accessKeyEnvKey = AWS_INIT_PROVIDER.inputs.accessKeyId.envKey;
  const secretAccessKeyEnvKey = AWS_INIT_PROVIDER.inputs.secretAccessKey.envKey;
  await makeEnv({
    ...initEnv,
    ...(initEnv[accessKeyEnvKey]
      ? {
          [accessKeyEnvKey]: {
            comment:
              "The current key may have excessive permissions. Update it with an S3FullAccess and CloudFrontFullAccess key.",
            value: initEnv[accessKeyEnvKey],
          },
        }
      : {}),
    ...(initEnv[secretAccessKeyEnvKey]
      ? {
          [secretAccessKeyEnvKey]: {
            comment:
              "The current key may have excessive permissions. Update it with an S3FullAccess and CloudFrontFullAccess key.",
            value: initEnv[secretAccessKeyEnvKey],
          },
        }
      : {}),
  });

  if (resourceInputs.bucketSelection === createKey) {
    await s3Manager.createBucket(bucketName, bucketRegion);
  }

  p.log.info(`Selected S3 Bucket: ${bucketName} (${bucketRegion})`);

  // Run S3 migrations
  const migrationsApplied = await s3Manager.runMigrations({
    approved: savedInputs.migrationApproved === "true",
    bucketName,
    nonInteractive,
    region: bucketRegion,
    migrations: [
      new Migration0001HotUpdater0_13_0(),
      new Migration0001HotUpdater0_18_0(),
    ],
  });
  if (migrationsApplied && savedInputs.migrationApproved !== "true") {
    await makeEnv({
      [AWS_INIT_PROVIDER.inputs.migrationApproved.envKey]: "true",
    });
  }

  // Create IAM role: Using IAMManager
  const iamManager = new IAMManager(bucketRegion, credentials);
  const lambdaRoleArn = await iamManager.createOrSelectRole();

  const ssmKeyPairManager = new SSMKeyPairManager(bucketRegion, credentials);

  const keyPair = await ssmKeyPairManager.getOrCreateKeyPair(
    `/hot-updater/${bucketName}/keypair`,
  );

  // Create CloudFront key group
  const { publicKeyId, keyGroupId } =
    await cloudFrontManager.getOrCreateKeyGroup(keyPair.publicKey);

  // Deploy Lambda@Edge: Using LambdaEdgeDeployer
  const lambdaEdgeDeployer = new LambdaEdgeDeployer(credentials);
  const ssmParameterName = `/hot-updater/${bucketName}/keypair`;
  const { functionArn } = await lambdaEdgeDeployer.deploy(
    lambdaRoleArn,
    lambdaName,
    {
      bucketName,
      publicKeyId: publicKeyId,
      ssmParameterName: ssmParameterName,
      ssmRegion: bucketRegion,
    },
  );

  // Create or update CloudFront distribution
  const { distributionDomain, distributionId } =
    await cloudFrontManager.createOrUpdateDistribution({
      keyGroupId,
      bucketName,
      distribution: selectedDistribution,
      functionArn,
    });

  // Update S3 bucket policy (allow CloudFront access)
  const accountId = functionArn.split(":")[4];
  await s3Manager.updateBucketPolicy({
    bucketName,
    region: bucketRegion,
    distributionId,
    accountId,
  });

  // Create configuration file
  const configWriteResult = await writeHotUpdaterConfig(
    getConfigScaffold(build, configAuthMode),
  );

  await makeEnv({
    [AWS_INIT_PROVIDER.inputs.distributionId.envKey]: distributionId,
  });

  // Install @aws-sdk/credential-provider-sso if SSO mode is selected
  if (mode === "sso") {
    await ensureInstallPackages({
      devDependencies: ["@aws-sdk/credential-provider-sso"],
    });
  } else if (mode === "local-session" || mode === "shared-profile") {
    await ensureInstallPackages({
      devDependencies: ["@aws-sdk/credential-providers"],
    });
  }

  p.log.success("Generated '.env.hotupdater' file with AWS settings.");
  if (configWriteResult.status === "created") {
    p.log.success("Generated 'hot-updater.config.ts' file with AWS settings.");
  } else if (configWriteResult.status === "merged") {
    p.log.success("Updated 'hot-updater.config.ts' file with AWS settings.");
  } else {
    p.log.warn(
      `Kept existing 'hot-updater.config.ts' unchanged: ${configWriteResult.reason}`,
    );
  }

  // Provide API URL for client use (using CloudFront domain)
  const sourceUrl = `https://${distributionDomain}/api/check-update`;
  p.note(transformTemplate(SOURCE_TEMPLATE, { source: sourceUrl }));
  p.log.message(
    `Next step: ${link("https://hot-updater.dev/docs/managed/aws#step-4-changeenv-file-optional")}`,
  );
  p.log.success("Done! 🎉");
};
