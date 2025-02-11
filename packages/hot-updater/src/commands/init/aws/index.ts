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
import { execa } from "execa";
import fs from "fs/promises";
import { regionLocationMap } from "./regionLocationMap";

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

/**
 * Deploy Lambda@Edge function
 * - Zip the local ./lambda folder, create a function in us-east-1 region,
 * - Publish a new version of the function
 */
const deployLambdaEdge = async (credentials: {
  accessKeyId: string;
  secretAccessKey: string;
}): Promise<{
  lambdaName: string;
  functionArn: string;
}> => {
  const { SDK } = await import("@hot-updater/aws/sdk");

  const cwd = getCwd();
  const lambdaDir = path.join(cwd, "lambda");

  // Enter Lambda function name (default: hot-updater-edge)
  const lambdaName = await p.text({
    message: "Enter the name of the Lambda@Edge function",
    defaultValue: "hot-updater-edge",
    placeholder: "hot-updater-edge",
  });
  if (p.isCancel(lambdaName)) process.exit(1);

  // Temporary zip file path (e.g. hot-updater-edge.zip)
  const zipFilePath = path.join(cwd, `${lambdaName}.zip`);

  // Compress lambda directory using zip command (zip must be installed)
  try {
    await execa("zip", ["-r", zipFilePath, "."], { cwd: lambdaDir });
  } catch (error) {
    throw new Error("Failed to create zip archive of Lambda function code");
  }

  // Create Lambda client for us-east-1 region
  const Lambda = SDK.Lambda.Lambda;
  const lambdaClient = new Lambda({ region: "us-east-1", credentials });

  // Get IAM Role ARN for Lambda@Edge (user must create role in advance)
  const lambdaRoleArn = await p.text({
    message:
      "Enter the IAM Role ARN for Lambda@Edge (must have necessary permissions)",
    defaultValue: "",
    placeholder: "arn:aws:iam::ACCOUNT_ID:role/your-lambda-role",
  });
  if (p.isCancel(lambdaRoleArn) || !lambdaRoleArn) process.exit(1);

  let functionArn: string;
  try {
    // Create Lambda function (with Publish option to publish new version)
    const createResp = await lambdaClient.createFunction({
      FunctionName: lambdaName,
      Runtime: "nodejs14.x",
      Role: lambdaRoleArn,
      Handler: "index.handler",
      Code: { ZipFile: await fs.readFile(zipFilePath) },
      Description: "Hot Updater Lambda@Edge function",
      Publish: true,
    });
    functionArn = createResp.FunctionArn!;
  } catch (error) {
    if (error instanceof Error) {
      p.log.error(`Failed to create Lambda function: ${error.message}`);
    }
    throw error;
  }

  return { lambdaName, functionArn };
};

export const initAwsS3LambdaEdge = async () => {
  const { SDK } = await import("@hot-updater/aws/sdk");

  p.log.step(
    "Please login with an account that has permissions to create S3, CloudFront, and Lambda",
  );

  const accessKeyId = await p.text({
    message: "Enter your AWS Access Key ID",
    validate: (value) => {
      if (!value) {
        return "Access Key ID is required";
      }
      return;
    },
  });
  if (p.isCancel(accessKeyId)) {
    process.exit(1);
  }

  const secretAccessKey = await p.text({
    message: "Enter your AWS Secret Access Key",
    validate: (value) => {
      if (!value) {
        return "Secret Access Key is required";
      }
      return;
    },
  });

  if (p.isCancel(secretAccessKey)) {
    process.exit(1);
  }

  const credentials = {
    accessKeyId,
    secretAccessKey,
  };

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

  // Enter S3 bucket name (or use default)
  const bucketName = await p.text({
    message: "Enter the name for the S3 bucket",
    defaultValue: "bundles",
    placeholder: "bundles",
  });
  if (p.isCancel(bucketName)) process.exit(1);

  try {
    await s3Client.createBucket({
      Bucket: bucketName,
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

  // Deploy Lambda@Edge function (us-east-1)
  const { functionArn } = await deployLambdaEdge(credentials);

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
    HOT_UPDATER_AWS_ACCESS_KEY_ID: credentials.accessKeyId,
    HOT_UPDATER_AWS_SECRET_ACCESS_KEY: credentials.secretAccessKey,
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
