import {
  colors,
  confirmInitInputPersistence,
  ensureInstallPackages,
  getHotUpdaterInitInputEnv,
  getInitProviderEnvVars,
  getInitProviderTextPromptValues,
  link,
  makeEnv,
  MissingInitInputsError,
  p,
  readHotUpdaterInitEnv,
  type RunInitOptions,
  transformTemplate,
  writeHotUpdaterConfig,
} from "@hot-updater/cli-tools";
import { execa } from "execa";

import {
  AWS_DATABASE_TYPES,
  type AwsDatabaseType,
} from "../src/awsDatabaseType";
import { resolveAwsAuth } from "./awsAuth";
import {
  assertAwsNonInteractiveInputs,
  resolveAwsInitInputs,
} from "./awsInitInputs";
import { CloudFrontManager } from "./cloudfront";
import { DynamoDBManager } from "./dynamodb";
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

  const database = await (async (): Promise<AwsDatabaseType> => {
    if (nonInteractive) {
      if (savedInputs.database) return savedInputs.database;
      p.log.warn(
        "This saved AWS init environment predates database selection. Continuing with deprecated s3Database to preserve existing metadata.",
      );
      return "s3";
    }
    const selected = await p.select<AwsDatabaseType>({
      initialValue: savedInputs.database ?? "dynamodb",
      message: AWS_INIT_PROVIDER.inputs.database.prompt.message,
      options: AWS_DATABASE_TYPES.map((type) => ({
        label:
          type === "dynamodb"
            ? "DynamoDB (Recommended)"
            : "S3 metadata (Deprecated)",
        value: type,
      })),
    });
    if (p.isCancel(selected)) process.exit(1);
    return selected;
  })();
  if (database === "s3") {
    p.log.warn(
      "s3Database is deprecated. Existing metadata remains supported, but new installations should use DynamoDB.",
    );
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
  if (database === "dynamodb") {
    p.log.message(
      `${colors.blue("AmazonDynamoDBFullAccess")}: Create and configure the metadata table`,
    );
  }

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
  if (createSavedBucket && savedInputs.migrationApproved !== "true") {
    throw new MissingInitInputsError(["HOT_UPDATER_AWS_MIGRATION_APPROVED"]);
  }
  if (savedBucketName && !existingBucket && !createSavedBucket) {
    p.log.warn("Saved S3 bucket was not found. Select a bucket again.");
  }
  const savedLambdaName = savedInputs.lambdaName;
  const savedDynamoDBTableName = savedInputs.dynamodbTableName;
  const resourceInputs = await p.group<{
    bucketSelection: string | symbol;
    bucketName: string | symbol | undefined;
    bucketRegion: string | symbol | undefined;
    dynamodbTableName: string | symbol | undefined;
    lambdaName: string | symbol;
  }>(
    {
      bucketSelection: () => {
        if (nonInteractive && existingBucket) {
          return Promise.resolve(existingBucket.name);
        }
        if (createSavedBucket) {
          return Promise.resolve(createKey);
        }
        return p.select<string>({
          initialValue: existingBucket?.name ?? availableBuckets[0]?.name,
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
                initialValue: isAwsRegion(savedBucketRegion)
                  ? savedBucketRegion
                  : undefined,
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
      dynamodbTableName: () =>
        database === "s3"
          ? Promise.resolve(undefined)
          : nonInteractive && savedDynamoDBTableName
            ? Promise.resolve(savedDynamoDBTableName)
            : p.text({
                ...getInitProviderTextPromptValues(
                  AWS_INIT_PROVIDER.inputs.dynamodbTableName.prompt,
                  savedDynamoDBTableName,
                ),
                message:
                  AWS_INIT_PROVIDER.inputs.dynamodbTableName.prompt.message,
                validate: (value) =>
                  value ? undefined : "DynamoDB table name is required",
              }),
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
  const { bucketName, bucketRegion, dynamodbTableName, lambdaName } =
    resourceInputs;
  if (!bucketName || !lambdaName) {
    p.log.error("AWS resource names are required.");
    process.exit(1);
  }

  if (!isAwsRegion(bucketRegion)) {
    p.log.error("AWS bucket region is required.");
    process.exit(1);
  }
  const resolvedDynamoDBTableName =
    typeof dynamodbTableName === "string" ? dynamodbTableName : undefined;
  if (database === "dynamodb" && !resolvedDynamoDBTableName) {
    p.log.error("AWS DynamoDB table name is required.");
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
    database,
    distributionId: selectedDistribution?.Id,
    dynamodbTableName: resolvedDynamoDBTableName,
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
              "The current key may have excessive permissions. Replace it with least-privilege S3, DynamoDB, and CloudFront permissions.",
            value: initEnv[accessKeyEnvKey],
          },
        }
      : {}),
    ...(initEnv[secretAccessKeyEnvKey]
      ? {
          [secretAccessKeyEnvKey]: {
            comment:
              "The current key may have excessive permissions. Replace it with least-privilege S3, DynamoDB, and CloudFront permissions.",
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

  if (database === "dynamodb" && resolvedDynamoDBTableName) {
    const dynamodbManager = new DynamoDBManager(bucketRegion, credentials);
    await dynamodbManager.ensureTable(resolvedDynamoDBTableName);
    p.log.info(
      `Using DynamoDB table: ${resolvedDynamoDBTableName} (${bucketRegion})`,
    );
  }

  // Create IAM role: Using IAMManager
  const iamManager = new IAMManager(bucketRegion, credentials);
  const lambdaRoleArn = await iamManager.createOrSelectRole({
    dynamodbTableName:
      database === "dynamodb" ? resolvedDynamoDBTableName : undefined,
  });

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
      databaseType: database,
      dynamodbRegion: bucketRegion,
      dynamodbTableName: resolvedDynamoDBTableName ?? "",
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
    getConfigScaffold(build, configAuthMode, database),
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
