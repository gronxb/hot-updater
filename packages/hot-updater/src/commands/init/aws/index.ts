import path from "path";
import { link } from "@/components/banner";
import { makeEnv } from "@/utils/makeEnv";
import { transformTemplate } from "@/utils/transformTemplate";
import * as p from "@clack/prompts";
import type {
  BucketLocationConstraint,
  DistributionConfig,
} from "@hot-updater/aws/sdk";
import { getCwd } from "@hot-updater/plugin-core";
import dayjs from "dayjs";
import fs from "fs/promises";
import { regionLocationMap } from "./regionLocationMap";

import { ExecaError, execa } from "execa";

// Template file: hot-updater.config.ts
const CONFIG_TEMPLATE = `
import { metro } from "@hot-updater/metro";
import { s3Storage, s3Database } from "@hot-updater/aws";
import { defineConfig } from "hot-updater";
import "dotenv/config";

const options = {
  bucketName: process.env.HOT_UPDATER_AWS_S3_BUCKET_NAME!,
  region: process.env.HOT_UPDATER_AWS_REGION!,
  credentials: {
    accessKeyId: process.env.HOT_UPDATER_AWS_ACCESS_KEY_ID!,
    secretAccessKey: process.env.HOT_UPDATER_AWS_SECRET_ACCESS_KEY!,
  },
};

export default defineConfig({
  build: metro(),
  storage: s3Storage(options),
  database: s3Database(options),
});
`;

// Template file: Example code to add to App.tsx
const SOURCE_TEMPLATE = `// add this to your App.tsx
import { HotUpdater } from "@hot-updater/react-native";

function App() {
  return ...
}

export default HotUpdater.wrap({
  source: "%%source%%",
})(App);`;

const checkIfAwsCliInstalled = async () => {
  try {
    await execa("aws", ["--version"]);
    return true;
  } catch (error) {
    return false;
  }
};

export async function createOrSelectIamRole(iamClient: any): Promise<string> {
  // Get list of IAM Roles
  const { Roles } = await iamClient.listRoles({});
  const createKey = `create/${Math.random().toString(36).substring(2, 15)}`;

  // Provide options to select existing Role or create new Role
  let roleName = await p.select({
    message: "IAM Role List",
    options: [
      ...(Roles ?? []).map((role: any) => ({
        value: role.RoleName!,
        label: `${role.RoleName} (${role.Arn})`,
      })),
      {
        value: createKey,
        label: "Create New IAM Role",
      },
    ],
  });

  if (p.isCancel(roleName)) process.exit(1);

  // Create new Role
  if (roleName === createKey) {
    const name = await p.text({
      message: "Enter the name of the new IAM Role",
      defaultValue: "hot-updater-edge-role",
      placeholder: "hot-updater-edge-role",
    });
    if (p.isCancel(name)) process.exit(1);
    roleName = name;

    // Set trust policy for Lambda@Edge
    const assumeRolePolicyDocument = JSON.stringify({
      Version: "2012-10-17",
      Statement: [
        {
          Effect: "Allow",
          Principal: {
            Service: "lambda.amazonaws.com",
          },
          Action: "sts:AssumeRole",
        },
      ],
    });

    try {
      const createRoleResp = await iamClient.createRole({
        RoleName: roleName,
        AssumeRolePolicyDocument: assumeRolePolicyDocument,
        Description: "Role for Lambda@Edge to access S3",
      });

      const lambdaRoleArn = createRoleResp.Role?.Arn!;
      p.log.info(`Created IAM role: ${roleName} (${lambdaRoleArn})`);

      // Attach required policies
      await iamClient.attachRolePolicy({
        RoleName: roleName,
        PolicyArn:
          "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole",
      });
      await iamClient.attachRolePolicy({
        RoleName: roleName,
        PolicyArn: "arn:aws:iam::aws:policy/AmazonS3ReadOnlyAccess",
      });
      p.log.info(
        `Attached AWSLambdaBasicExecutionRole and AmazonS3ReadOnlyAccess policies to ${roleName}`,
      );

      return lambdaRoleArn;
    } catch (error) {
      if (error instanceof Error) {
        p.log.error(
          `Error setting up IAM role for Lambda@Edge: ${error.message}`,
        );
      }
      process.exit(1);
    }
  } else {
    // Use existing Role
    const selectedRole = Roles?.find((role: any) => role.RoleName === roleName);
    const lambdaRoleArn: string | null = selectedRole?.Arn ?? null;
    if (!lambdaRoleArn) {
      p.log.error("Failed to select existing IAM role for Lambda@Edge");
      process.exit(1);
    }
    p.log.info(`Using existing IAM role: ${roleName} (${lambdaRoleArn})`);
    return lambdaRoleArn;
  }
}

/**
 * Deploy Lambda@Edge function
 * - Zip the local ./lambda folder, create a function in us-east-1 region,
 * - Publish a new version of the function
 */
export const deployLambdaEdge = async (
  credentials:
    | {
        accessKeyId: string;
        secretAccessKey: string;
      }
    | undefined,
  lambdaRoleArn: string,
): Promise<{
  lambdaName: string;
  functionArn: string;
}> => {
  const lambdaPath = require.resolve("@hot-updater/aws/lambda");
  const lambdaDir = path.dirname(lambdaPath);
  const { SDK } = await import("@hot-updater/aws/sdk");

  const cwd = getCwd();

  // Enter Lambda function name
  const lambdaName = await p.text({
    message: "Enter the name of the Lambda@Edge function",
    defaultValue: "hot-updater-edge",
    placeholder: "hot-updater-edge",
  });
  if (p.isCancel(lambdaName)) process.exit(1);

  // Create temporary zip file
  const zipFilePath = path.join(cwd, `${lambdaName}.zip`);

  // Compress Lambda code to zip
  try {
    await execa("zip", ["-r", zipFilePath, "."], { cwd: lambdaDir });
  } catch (error) {
    throw new Error("Failed to create zip archive of Lambda function code");
  }

  // Lambda client (us-east-1)
  const lambdaClient = new SDK.Lambda.Lambda({
    region: "us-east-1",
    credentials,
  });

  // Create or update Lambda function
  let functionArn: string | null = null;
  let functionVersion: string | null = null;

  try {
    // Create new function
    const createResp = await lambdaClient.createFunction({
      FunctionName: lambdaName,
      Runtime: "nodejs20.x",
      Role: lambdaRoleArn,
      Handler: "index.handler",
      Code: { ZipFile: await fs.readFile(zipFilePath) },
      Description: "Hot Updater Lambda@Edge function",
      Publish: true,
    });

    functionArn = createResp.FunctionArn ?? null;
    functionVersion = createResp.Version ?? null;
  } catch (error) {
    // If function already exists -> updateFunctionCode
    if (error instanceof Error && error.name === "ResourceConflictException") {
      p.log.info(
        `Function "${lambdaName}" already exists. Updating function code...`,
      );
      const updateResp = await lambdaClient.updateFunctionCode({
        FunctionName: lambdaName,
        ZipFile: await fs.readFile(zipFilePath),
        Publish: true,
      });
      functionArn = updateResp.FunctionArn ?? null;
      functionVersion = updateResp.Version ?? null;
    } else {
      // Pass through other errors
      if (error instanceof Error) {
        p.log.error(
          `Failed to create or update Lambda function: ${error.message}`,
        );
      }
      throw error;
    }
  }

  if (!functionArn || !functionVersion) {
    p.log.error("Failed to create or update Lambda function");
    process.exit(1);
  }

  // Lambda@Edge requires ARN with version
  if (!functionArn.includes(`:${functionVersion}`)) {
    functionArn = `${functionArn}:${functionVersion}`;
  }

  p.log.info(`Using Lambda ARN: ${functionArn}`);

  return { lambdaName, functionArn };
};

export const initAwsS3LambdaEdge = async () => {
  const { SDK } = await import("@hot-updater/aws/sdk");

  const isAwsCliInstalled = await checkIfAwsCliInstalled();
  if (!isAwsCliInstalled) {
    p.log.error(
      `AWS CLI is not installed. Please visit ${link("https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html")} for installation instructions`,
    );
    process.exit(1);
  }

  // 1. Start IAM Identity Center
  // 2. Add permission set with S3FullAccess, LambdaFullAccess, CloudFrontFullAccess
  // 3. Add account

  let credentials:
    | {
        accessKeyId: string;
        secretAccessKey: string;
      }
    | undefined = undefined;

  const mode = await p.select({
    message: "Select the mode to login to AWS",
    options: [
      { label: "AWS SSO Login", value: "sso" },
      { label: "AWS Access Key ID & Secret Access Key", value: "account" },
    ],
  });
  if (p.isCancel(mode)) process.exit(1);

  if (mode === "sso") {
    try {
      const profile = await p.text({
        message: "Enter the SSO profile name",
        defaultValue: "default",
        placeholder: "default",
      });
      if (p.isCancel(profile)) {
        process.exit(1);
      }

      await execa("aws", ["sso", "login", "--profile", profile], {
        stdio: "inherit",
      });

      credentials = await SDK.CredentialsProvider.fromSSO({
        profile,
      })();
    } catch (error) {
      if (error instanceof ExecaError) {
        p.log.error(error.stdout || error.stderr || error.message);
      }
      process.exit(1);
    }
  } else {
    p.log.step(
      "Please login with an account that has permissions to create S3, CloudFront, and Lambda (these permissions are only needed once during initialization)",
    );

    credentials = await p.group({
      accessKeyId: () =>
        p.text({
          message: "Enter your AWS Access Key ID",
          validate: (value) => {
            if (!value) {
              return "Access Key ID is required";
            }
            return;
          },
        }),
      secretAccessKey: () =>
        p.text({
          message: "Enter your AWS Secret Access Key",
          validate: (value) => {
            if (!value) {
              return "Secret Access Key is required";
            }

            return;
          },
        }),
    });

    if (p.isCancel(credentials)) process.exit(1);

    credentials = {
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
    };
  }

  // Enter region for AWS S3 bucket creation
  const $region = await p.select({
    message: "Enter AWS region for the S3 bucket",
    options: Object.values(SDK.S3.BucketLocationConstraint).map((r) => ({
      label: `${r} (${regionLocationMap[r]})` as string,
      value: r as string,
    })),
  });
  if (p.isCancel($region)) process.exit(1);

  const region = $region as BucketLocationConstraint;
  // Create S3 client
  const S3 = SDK.S3.S3;
  const s3Client = new S3({ region, credentials });
  const availableBuckets: { name: string }[] = [];
  try {
    await p.tasks([
      {
        title: "Checking S3 Buckets...",
        task: async () => {
          const buckets = await s3Client.listBuckets({});
          availableBuckets.push(
            ...(buckets.Buckets ?? [])
              .filter((bucket) => bucket.Name)
              .map((bucket) => ({
                name: bucket.Name!,
              })),
          );
        },
      },
    ]);
  } catch (e) {
    if (e instanceof Error) {
      p.log.error(e.message);
    }
    throw e;
  }

  const createKey = `create/${Math.random().toString(36).substring(2, 15)}`;

  let bucketName = await p.select({
    message: "S3 Bucket List",
    options: [
      ...availableBuckets.map((bucket) => ({
        value: bucket.name,
        label: bucket.name,
      })),
      {
        value: createKey,
        label: "Create New S3 Bucket",
      },
    ],
  });

  if (p.isCancel(bucketName)) {
    process.exit(1);
  }

  if (bucketName === createKey) {
    const name = await p.text({
      message: "Enter the name of the new S3 Bucket",
      defaultValue: "bundles",
      placeholder: "bundles",
    });
    if (p.isCancel(name)) {
      process.exit(1);
    }
    bucketName = name;

    try {
      await s3Client.createBucket({
        Bucket: name,
        CreateBucketConfiguration: {
          LocationConstraint: region,
        },
      });
      p.log.info(`Created S3 bucket: ${bucketName}`);
    } catch (error) {
      if (error instanceof Error) {
        p.log.error(`Failed to create S3 bucket: ${error.message}`);
      }
      throw error;
    }
  }
  p.log.info(`Selected S3 Bucket: ${bucketName}`);

  const iamClient = new SDK.IAM.IAM({ region, credentials });
  const lambdaRoleArn = await createOrSelectIamRole(iamClient);

  // Deploy Lambda@Edge function (us-east-1)
  const { functionArn } = await deployLambdaEdge(credentials, lambdaRoleArn);

  // Create CloudFront distribution: Use S3 as origin and connect Lambda@Edge function to viewer-request event
  const Cloudfront = SDK.CloudFront.CloudFront;
  const cloudfrontClient = new Cloudfront({ region, credentials });

  const distributionConfig: DistributionConfig = {
    CallerReference: dayjs().format(),
    Comment: "Hot Updater CloudFront distribution",
    Enabled: true,
    Origins: {
      Quantity: 1,
      Items: [
        {
          Id: bucketName,
          DomainName: `${bucketName}.s3.${region}.amazonaws.com`,
          S3OriginConfig: { OriginAccessIdentity: "" },
        },
      ],
    },
    DefaultCacheBehavior: {
      TargetOriginId: bucketName,
      ViewerProtocolPolicy: "redirect-to-https",
      LambdaFunctionAssociations: {
        Quantity: 1,
        Items: [
          {
            EventType: "viewer-request",
            LambdaFunctionARN: functionArn, // Use published version ARN
          },
        ],
      },
      ForwardedValues: {
        QueryString: false,
        Cookies: { Forward: "none" },
      },
      MinTTL: 0,
    },
    DefaultRootObject: "index.html",
    ViewerCertificate: { CloudFrontDefaultCertificate: true },
    Restrictions: {
      GeoRestriction: {
        RestrictionType: "none",
        Quantity: 0,
      },
    },
  };

  let distributionId: string;
  let distributionDomain: string;
  try {
    const distResp = await cloudfrontClient.createDistribution({
      DistributionConfig: distributionConfig,
    });
    distributionId = distResp.Distribution?.Id!;
    distributionDomain = distResp.Distribution?.DomainName!;
    p.log.info(`Created CloudFront distribution with ID: ${distributionId}`);
  } catch (error) {
    if (error instanceof Error) {
      p.log.error(`Failed to create CloudFront distribution: ${error.message}`);
    }
    throw error;
  }

  // Create config file and environment variable file
  await fs.writeFile("hot-updater.config.ts", CONFIG_TEMPLATE);
  await makeEnv({
    HOT_UPDATER_AWS_S3_BUCKET_NAME: bucketName,
    HOT_UPDATER_AWS_REGION: region,

    // FIXME: only s3 access key id and secret access key are needed
    HOT_UPDATER_AWS_ACCESS_KEY_ID: credentials?.accessKeyId ?? "",
    HOT_UPDATER_AWS_SECRET_ACCESS_KEY: credentials?.secretAccessKey ?? "",
  });

  p.log.success("Generated '.env' file with AWS settings.");
  p.log.success("Generated 'hot-updater.config.ts' file with AWS settings.");

  // Provide API URL to client side using CloudFront domain
  const sourceUrl = `https://${distributionDomain}/api/check-update`;
  p.note(
    transformTemplate(SOURCE_TEMPLATE, {
      source: sourceUrl,
    }),
  );

  p.log.message(
    `Next step: ${link("https://your-aws-integration-guide-url.com")}`,
  );
  p.log.success("Done! 🎉");
};
