import { fromSSO } from "@aws-sdk/credential-providers";
import {
  type BuildType,
  link,
  makeEnv,
  prompts as p,
  colors as picocolors,
  transformTemplate,
} from "@hot-updater/cli-tools";
import { ExecaError, execa } from "execa";
import fs from "fs";
import { CloudFrontManager } from "./cloudfront";
import { IAMManager } from "./iam";
import { LambdaEdgeDeployer } from "./lambdaEdge";
import { Migration0001HotUpdater0_13_0 } from "./migrations/Migration0001HotUpdater0_13_0";
import { Migration0001HotUpdater0_18_0 } from "./migrations/Migration0001HotUpdater0_18_0";
import { type AwsRegion, regionLocationMap } from "./regionLocationMap";
import { S3Manager } from "./s3";
import { SSMKeyPairManager } from "./ssm";
import { getConfigTemplate, SOURCE_TEMPLATE } from "./templates";

const checkIfAwsCliInstalled = async () => {
  try {
    await execa("aws", ["--version"]);
    return true;
  } catch {
    return false;
  }
};

export const runInit = async ({ build }: { build: BuildType }) => {
  const isAwsCliInstalled = await checkIfAwsCliInstalled();
  if (!isAwsCliInstalled) {
    p.log.error(
      `AWS CLI is not installed. Please visit ${link("https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html")} for installation instructions`,
    );
    process.exit(1);
  }

  let credentials:
    | { accessKeyId: string; secretAccessKey: string; sessionToken?: string }
    | undefined;

  // Select: AWS login mode
  const mode = await p.select({
    message: "Select the mode to login to AWS",
    options: [
      {
        label: "AWS Access Key ID & Secret Access Key (Recommend)",
        value: "account",
      },
      { label: "AWS SSO Login", value: "sso" },
    ],
  });
  if (p.isCancel(mode)) process.exit(1);

  p.log.message(picocolors.blue("The following permissions are required:"));
  p.log.message(
    `${picocolors.blue("AmazonS3FullAccess")}: Create and read S3 buckets`,
  );
  p.log.message(
    `${picocolors.blue("AWSLambda_FullAccess")}: Create and update Lambda functions`,
  );
  p.log.message(
    `${picocolors.blue("CloudFrontFullAccess")}: Create and update CloudFront distributions`,
  );
  p.log.message(
    `${picocolors.blue("IAMFullAccess")}: Get or create IAM roles for Lambda@Edge`,
  );
  p.log.message(
    `${picocolors.blue("AmazonSSMFullAccess")}: Access to SSM Parameters for storing CloudFront key pairs`,
  );

  if (mode === "sso") {
    try {
      const profile = await p.text({
        message: "Enter the SSO profile name",
        defaultValue: "default",
        placeholder: "default",
      });
      if (p.isCancel(profile)) process.exit(1);
      await execa("aws", ["sso", "login", "--profile", profile], {
        stdio: "inherit",
        shell: true,
      });
      credentials = await fromSSO({ profile })();
    } catch (error) {
      if (error instanceof ExecaError) {
        p.log.error(error.stdout || error.stderr || error.message);
      }
      process.exit(1);
    }
  } else {
    const creds = await p.group({
      accessKeyId: () =>
        p.text({
          message: "Enter your AWS Access Key ID",
          validate: (value) =>
            value ? undefined : "Access Key ID is required",
        }),
      secretAccessKey: () =>
        p.password({
          message: "Enter your AWS Secret Access Key",
          validate: (value) =>
            value ? undefined : "Secret Access Key is required",
        }),
    });
    if (p.isCancel(creds)) process.exit(1);
    credentials = {
      accessKeyId: creds.accessKeyId,
      secretAccessKey: creds.secretAccessKey,
    };
  }

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
  let bucketName = await p.select({
    message: "S3 Bucket List",
    options: [
      ...availableBuckets.map((bucket) => ({
        value: bucket.name,
        label: `${bucket.name} (${bucket.region})`,
      })),
      { value: createKey, label: "Create New S3 Bucket" },
    ],
  });
  if (p.isCancel(bucketName)) process.exit(1);

  let bucketRegion: AwsRegion | undefined = availableBuckets.find(
    (bucket) => bucket.name === bucketName,
  )?.region;

  if (bucketName === createKey) {
    const name = await p.text({
      message: "Enter the name of the new S3 Bucket",
      defaultValue: "hot-updater-storage",
      placeholder: "hot-updater-storage",
    });
    if (p.isCancel(name)) {
      process.exit(1);
    }
    bucketName = name;
    const selectedRegion = await p.select({
      message: "Enter AWS region for the S3 bucket",
      options: Object.entries(regionLocationMap).map(([region, location]) => ({
        label: `${region} (${location})`,
        value: region,
      })),
    });
    if (p.isCancel(selectedRegion)) {
      process.exit(1);
    }
    bucketRegion = selectedRegion as AwsRegion;
    await s3Manager.createBucket(bucketName, bucketRegion);
  }

  if (!bucketRegion) {
    p.log.error("Failed to get S3 bucket region");
    process.exit(1);
  }

  p.log.info(`Selected S3 Bucket: ${bucketName} (${bucketRegion})`);

  // Run S3 migrations
  await s3Manager.runMigrations({
    bucketName,
    region: bucketRegion,
    migrations: [
      new Migration0001HotUpdater0_13_0(),
      new Migration0001HotUpdater0_18_0(),
    ],
  });

  // Create IAM role: Using IAMManager
  const iamManager = new IAMManager(bucketRegion, credentials);
  const lambdaRoleArn = await iamManager.createOrSelectRole();

  const ssmKeyPairManager = new SSMKeyPairManager(bucketRegion, credentials);

  const keyPair = await ssmKeyPairManager.getOrCreateKeyPair(
    `/hot-updater/${bucketName}/keypair`,
  );

  // CloudFront related tasks: Create CloudFrontManager instance
  const cloudFrontManager = new CloudFrontManager(bucketRegion, credentials);

  // Create CloudFront key group
  const { publicKeyId, keyGroupId } =
    await cloudFrontManager.getOrCreateKeyGroup(keyPair.publicKey);

  // Deploy Lambda@Edge: Using LambdaEdgeDeployer
  const lambdaEdgeDeployer = new LambdaEdgeDeployer(credentials);
  const ssmParameterName = `/hot-updater/${bucketName}/keypair`;
  const { functionArn } = await lambdaEdgeDeployer.deploy(lambdaRoleArn, {
    publicKeyId: publicKeyId,
    ssmParameterName: ssmParameterName,
    ssmRegion: bucketRegion,
  });

  // Create or update CloudFront distribution
  const { distributionDomain, distributionId } =
    await cloudFrontManager.createOrUpdateDistribution({
      keyGroupId,
      bucketName,
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
  if (mode === "sso") {
    await fs.promises.writeFile(
      "hot-updater.config.ts",
      getConfigTemplate(build, { sessionToken: true }),
    );
  } else {
    await fs.promises.writeFile(
      "hot-updater.config.ts",
      getConfigTemplate(build, { sessionToken: false }),
    );
  }
  const comment =
    mode === "account"
      ? "The current key may have excessive permissions. Update it with an S3FullAccess and CloudFrontFullAccess key."
      : "This key was generated via SSO login and may expire. Update it with an S3FullAccess and CloudFrontFullAccess key.";

  await makeEnv({
    HOT_UPDATER_S3_BUCKET_NAME: bucketName,
    HOT_UPDATER_S3_REGION: bucketRegion,
    HOT_UPDATER_S3_ACCESS_KEY_ID: { comment, value: credentials.accessKeyId },
    HOT_UPDATER_S3_SECRET_ACCESS_KEY: {
      comment,
      value: credentials.secretAccessKey,
    },
    ...(mode === "sso" && {
      HOT_UPDATER_S3_SESSION_TOKEN: credentials.sessionToken,
    }),
    HOT_UPDATER_CLOUDFRONT_DISTRIBUTION_ID: distributionId,
  });
  p.log.success("Generated '.env.hotupdater' file with AWS settings.");
  p.log.success("Generated 'hot-updater.config.ts' file with AWS settings.");

  // Provide API URL for client use (using CloudFront domain)
  const sourceUrl = `https://${distributionDomain}/api/check-update`;
  p.note(transformTemplate(SOURCE_TEMPLATE, { source: sourceUrl }));
  p.log.message(
    `Next step: ${link("https://hot-updater.dev/docs/managed/aws#step-4-changeenv-file-optional")}`,
  );
  p.log.success("Done! 🎉");
};
