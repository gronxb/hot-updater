import {
  colors,
  confirmInitInputPersistence,
  ensureInstallPackages,
  getHotUpdaterInitInputEnv,
  getInitProviderEnvVars,
  getInitProviderTextPromptValues,
  link,
  loadManagedServerDefinition,
  makeEnv,
  p,
  printAppSetup,
  readHotUpdaterInitEnv,
  readManagedServerDefinition,
  replacingServerDefinitions,
  type RunInitOptions,
  writeHotUpdaterFiles,
} from "@hot-updater/cli-tools";
import type { PluginTables } from "@hot-updater/server/database";
import {
  clientAuthOf,
  clientPluginsOf,
  provisionClientCredential,
  type ProvisionedClientCredential,
} from "@hot-updater/server/db";
import {
  clientEndpointsOf,
  managedServerDefinitionOf,
} from "@hot-updater/server/internal";
import { execa } from "execa";

import { dynamoDB, migrateDynamoDB } from "../src/dynamoDB";
import { plugins } from "../src/plugins";
import { resolveAwsAuth } from "./awsAuth";
import { getAwsV1SsmParameterName } from "./awsInfrastructureNames";
import {
  assertAwsInfrastructureGeneration,
  assertAwsLambdaCanInitialize,
} from "./awsInfrastructureState";
import {
  assertAwsNonInteractiveInputs,
  resolveAwsInitInputs,
} from "./awsInitInputs";
import { CloudFrontManager } from "./cloudfront";
import { pluginCacheBehaviorPaths } from "./cloudfrontDistributionConfig";
import { DynamoDBManager } from "./dynamodb";
import { IAMManager } from "./iam";
import { initProvider as AWS_INIT_PROVIDER } from "./init/index";
import { LambdaEdgeDeployer, stageLambda } from "./lambdaEdge";
import { type AwsRegion, regionLocationMap } from "./regionLocationMap";
import { S3Manager } from "./s3";
import { SSMKeyPairManager } from "./ssm";
import { getConfigScaffold } from "./templates";

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

export const prepareDynamoDBDeployment = async (
  input: {
    readonly credentials: {
      readonly accessKeyId: string;
      readonly secretAccessKey: string;
      readonly sessionToken?: string;
    };
    readonly region: string;
    readonly tableName: string;
  },
  /** The plugins the server runs, whose tables and settings are created too. */
  serverPlugins: readonly PluginTables[],
): Promise<void> => {
  const dynamodbManager = new DynamoDBManager(input.region, input.credentials);
  await dynamodbManager.ensureTable(input.tableName);
  // The plugin reads nothing until the table's schema settings exist.
  await migrateDynamoDB(input, serverPlugins);
};

export const runInit = async ({
  build,
  envFile,
  otherServerDefinitions,
}: RunInitOptions) => {
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
  p.log.message(
    `${colors.blue("AmazonDynamoDBFullAccess_v2")}: Create and configure the metadata table`,
  );

  const { awsProfile, configAuthMode, credentials, mode } =
    await resolveAwsAuth(providerEnv, nonInteractive);
  const scaffold = replacingServerDefinitions(
    getConfigScaffold(build, configAuthMode),
    otherServerDefinitions,
  );
  const definition = await readManagedServerDefinition(scaffold, process.cwd());
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
        nonInteractive && savedDynamoDBTableName
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
  if (!resolvedDynamoDBTableName) {
    p.log.error("AWS DynamoDB table name is required.");
    process.exit(1);
  }
  await assertAwsLambdaCanInitialize({
    credentials,
    lambdaName,
  });
  const cloudFrontManager = new CloudFrontManager(bucketRegion, credentials);
  const selectedDistribution = await cloudFrontManager.selectDistribution({
    bucketName,
    distributionId: savedInputs.distributionId,
    nonInteractive,
  });
  if (selectedDistribution?.DomainName) {
    await assertAwsInfrastructureGeneration({
      domainName: selectedDistribution.DomainName,
    });
  }
  const resolvedInputs = {
    ...resolvedAuthInputs,
    bucketName,
    bucketRegion,
    distributionId: selectedDistribution?.Id,
    dynamodbTableName: resolvedDynamoDBTableName,
    lambdaName,
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

  // The server the function runs: the package's, or the project's edited
  // definition, which reads what .env.hotupdater now holds. It is checked and
  // its function bundled before init changes any resource. CloudFront sends
  // the paths of its plugins' client endpoints to the function.
  const server = definition.edited
    ? await loadManagedServerDefinition(definition, (hotUpdater) => {
        const loaded = managedServerDefinitionOf(hotUpdater, {
          provider: "AWS",
          database: "dynamoDB",
          storage: "s3",
          resources: {
            database: {
              region: bucketRegion,
              tableName: resolvedDynamoDBTableName,
            },
            storage: { bucketName },
          },
        });
        return {
          plugins: loaded.plugins,
          pluginPaths: pluginCacheBehaviorPaths(loaded.clientEndpoints),
        };
      })
    : {
        plugins,
        pluginPaths: pluginCacheBehaviorPaths(clientEndpointsOf(plugins)),
      };
  const serverPlugins = server.plugins;
  const { pluginPaths } = server;
  const definitionLambda = definition.edited
    ? await stageLambda(definition.path)
    : undefined;

  if (resourceInputs.bucketSelection === createKey) {
    await s3Manager.createBucket(bucketName, bucketRegion);
  }

  p.log.info(`Selected S3 Bucket: ${bucketName} (${bucketRegion})`);

  await prepareDynamoDBDeployment(
    {
      credentials,
      region: bucketRegion,
      tableName: resolvedDynamoDBTableName,
    },
    serverPlugins,
  );
  const databasePlugin = dynamoDB({
    credentials,
    region: bucketRegion,
    tableName: resolvedDynamoDBTableName,
  });
  // The app's credential, through the managed server's plugins, on the table they read.
  let credential: ProvisionedClientCredential | undefined;
  try {
    credential = await provisionClientCredential(
      databasePlugin,
      serverPlugins,
      {
        env: providerEnv,
        name: "AWS init",
      },
    );
    if (credential !== undefined) {
      await makeEnv({ [credential.env]: credential.value });
    }
  } finally {
    await databasePlugin.dispose?.();
  }
  p.log.info(
    `Using DynamoDB table: ${resolvedDynamoDBTableName} (${bucketRegion})`,
  );

  // Create IAM role: Using IAMManager
  const iamManager = new IAMManager(bucketRegion, credentials);
  const ssmParameterName = getAwsV1SsmParameterName(lambdaName);
  const lambdaRoleArn = await iamManager.createOrSelectRole({
    bucketName,
    dynamodbTableName: resolvedDynamoDBTableName,
    lambdaName,
    ssmParameterName,
    plugins: serverPlugins,
    // The function versions the distribution may still run keep their
    // access until it deploys the one init records.
    edge: selectedDistribution?.Id
      ? await cloudFrontManager.edgeDeploymentOf(
          selectedDistribution.Id,
          lambdaName,
        )
      : undefined,
  });

  const ssmKeyPairManager = new SSMKeyPairManager(bucketRegion, credentials);

  const keyPair = await ssmKeyPairManager.getOrCreateKeyPair(ssmParameterName);

  // Create CloudFront key group
  const { publicKeyId, keyGroupId } =
    await cloudFrontManager.getOrCreateKeyGroup(keyPair.publicKey);

  // Deploy Lambda@Edge: Using LambdaEdgeDeployer
  const lambdaEdgeDeployer = new LambdaEdgeDeployer(credentials);
  const { functionArn } = await lambdaEdgeDeployer.deploy(
    lambdaRoleArn,
    lambdaName,
    {
      bucketName,
      dynamodbRegion: bucketRegion,
      dynamodbTableName: resolvedDynamoDBTableName,
      publicKeyId: publicKeyId,
      ssmParameterName: ssmParameterName,
      ssmRegion: bucketRegion,
    },
    definitionLambda ?? (await stageLambda(undefined)),
  );

  // Create or update CloudFront distribution
  const { distributionDomain, distributionId } =
    await cloudFrontManager.createOrUpdateDistribution({
      keyGroupId,
      bucketName,
      clientHeaders: clientAuthOf(serverPlugins)?.varyHeaders ?? [],
      distribution: selectedDistribution,
      functionArn,
      pluginPaths,
    });
  await iamManager.recordDeployedVersion({
    dynamodbTableName: resolvedDynamoDBTableName,
    functionArn,
    lambdaName,
    plugins: serverPlugins,
  });

  // Update S3 bucket policy (allow CloudFront access)
  const accountId = functionArn.split(":")[4];
  await s3Manager.updateBucketPolicy({
    bucketName,
    region: bucketRegion,
    distributionId,
    accountId,
  });

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
  await writeHotUpdaterFiles(scaffold, {
    cwd: process.cwd(),
    settings: "AWS",
  });

  // The app's server URL is the CloudFront domain.
  printAppSetup({
    baseURL: `https://${distributionDomain}`,
    ...(credential === undefined ? {} : { credential }),
    clientPlugins: clientPluginsOf(serverPlugins),
  });
  p.log.message(
    `Next step: ${link(
      "https://hot-updater.dev/docs/managed/aws#step-3-add-hotupdater-to-your-project",
    )}`,
  );
  p.log.success("Done! 🎉");
};

// Shared request templates for the infrastructure scaffold.
export {
  buildDynamoDBCreateTableInput,
  buildDynamoDBBackupInput,
  buildDynamoDBSchemaSettingsInput,
  buildDynamoDBTimeToLiveInput,
} from "./dynamodb";
export {
  buildDynamoDBPolicy,
  buildS3Policy,
  buildSsmPolicy,
  LAMBDA_EDGE_TRUST_POLICY,
} from "./iam";
