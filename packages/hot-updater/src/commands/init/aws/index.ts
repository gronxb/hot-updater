import path from "path";
import { link } from "@/components/banner";
import { transformTemplate } from "@/utils/transformTemplate";
import * as p from "@clack/prompts";
import type {
  BucketLocationConstraint,
  DistributionConfig,
} from "@hot-updater/aws/sdk";
import { copyDirToTmp, getCwd } from "@hot-updater/plugin-core";
import dayjs from "dayjs";
import { merge } from "es-toolkit";
import fs from "fs/promises";

import { createZip } from "@/utils/createZip";
import { delay } from "@/utils/delay";
import { makeEnv } from "@/utils/makeEnv";
import { ExecaError, execa } from "execa";
import picocolors from "picocolors";
import { regionLocationMap } from "./regionLocationMap";
import { transformEnv } from "./transformEnv";

// Template file: hot-updater.config.ts
const CONFIG_TEMPLATE_WITH_SESSION = `
import { metro } from "@hot-updater/metro";
import { s3Storage, s3Database } from "@hot-updater/aws";
import { defineConfig } from "hot-updater";
import "dotenv/config";

const options = {
  bucketName: process.env.HOT_UPDATER_S3_BUCKET_NAME!,
  region: process.env.HOT_UPDATER_S3_REGION!,
  credentials: {
    accessKeyId: process.env.HOT_UPDATER_S3_ACCESS_KEY_ID!,
    secretAccessKey: process.env.HOT_UPDATER_S3_SECRET_ACCESS_KEY!,
    // This token may expire. For permanent use, it's recommended to get a key with S3FullAccess permission and remove this field.
    sessionToken: process.env.HOT_UPDATER_S3_SESSION_TOKEN!,
  },
};

export default defineConfig({
  build: metro({ enableHermes: true }),
  storage: s3Storage(options),
  database: s3Database(options),
});
`;

const CONFIG_TEMPLATE = `
import { metro } from "@hot-updater/metro";
import { s3Storage, s3Database } from "@hot-updater/aws";
import { defineConfig } from "hot-updater";
import "dotenv/config";

const options = {
  bucketName: process.env.HOT_UPDATER_S3_BUCKET_NAME!,
  region: process.env.HOT_UPDATER_S3_REGION!,
  credentials: {
    accessKeyId: process.env.HOT_UPDATER_S3_ACCESS_KEY_ID!,
    secretAccessKey: process.env.HOT_UPDATER_S3_SECRET_ACCESS_KEY!,
  },
};

export default defineConfig({
  build: metro({ enableHermes: true }),
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

export async function createOrSelectIamRole({
  region,
  credentials,
}: {
  region: BucketLocationConstraint;
  credentials: {
    accessKeyId: string;
    secretAccessKey: string;
  };
}): Promise<string> {
  const { SDK } = await import("@hot-updater/aws/sdk");
  const iamClient = new SDK.IAM.IAM({ region, credentials });

  // Set trust policy for Lambda@Edge
  const assumeRolePolicyDocument = JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Principal: {
          Service: ["lambda.amazonaws.com", "edgelambda.amazonaws.com"],
        },
        Action: "sts:AssumeRole",
      },
    ],
  });

  const roleName = "hot-updater-edge-role";

  try {
    // Check if role already exists
    const { Role: existingRole } = await iamClient.getRole({
      RoleName: roleName,
    });

    if (existingRole?.Arn) {
      p.log.info(`Using existing IAM role: ${roleName} (${existingRole.Arn})`);
      return existingRole.Arn;
    }
  } catch (error) {
    // Role doesn't exist, create new one
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
    } catch (createError) {
      if (createError instanceof Error) {
        p.log.error(
          `Error setting up IAM role for Lambda@Edge: ${createError.message}`,
        );
      }
      process.exit(1);
    }
  }
  throw new Error("Failed to create or get IAM role");
}

/**
 * Deploy Lambda@Edge function
 * - Zip the local ./lambda folder, create a function in us-east-1 region,
 * - Publish a new version of the function
 */
export const deployLambdaEdge = async ({
  region,
  bucketName,
  credentials,
  lambdaRoleArn,
}: {
  region: BucketLocationConstraint;
  bucketName: string;
  credentials: {
    accessKeyId: string;
    secretAccessKey: string;
  };
  lambdaRoleArn: string;
}) => {
  const { SDK } = await import("@hot-updater/aws/sdk");
  const cwd = getCwd();

  // 1. Lambda function name
  const lambdaName = await p.text({
    message: "Enter the name of the Lambda@Edge function",
    defaultValue: "hot-updater-edge",
    placeholder: "hot-updater-edge",
  });
  if (p.isCancel(lambdaName)) process.exit(1);

  // 2. Create zip file
  const lambdaPath = require.resolve("@hot-updater/aws/lambda");
  const lambdaDir = path.dirname(lambdaPath);

  const { tmpDir, removeTmpDir } = await copyDirToTmp(lambdaDir);
  const code = await transformEnv(
    await fs.readFile(path.join(tmpDir, "index.cjs"), "utf-8"),
    {
      S3_REGION: region,
      S3_BUCKET_NAME: bucketName,
    },
  );
  await fs.writeFile(path.join(tmpDir, "index.cjs"), code);

  // 3. Lambda client
  const lambdaClient = new SDK.Lambda.Lambda({
    region: "us-east-1",
    credentials,
  });

  const functionArn: {
    arn: string | null;
    version: string | null;
  } = {
    arn: null,
    version: null,
  };

  const zipFilePath = path.join(cwd, `${lambdaName}.zip`);
  // 4. Show step-by-step indicators using p.tasks
  await p.tasks([
    {
      title: "Compressing Lambda code to zip",
      task: async () => {
        try {
          await createZip({
            outfile: zipFilePath,
            targetDir: tmpDir,
          });
          return "Compressed Lambda code to zip";
        } catch (error) {
          throw new Error(
            "Failed to create zip archive of Lambda function code",
          );
        }
      },
    },
    {
      title: "Creating or Updating Lambda function",
      task: async (message) => {
        try {
          // Create new function
          const createResp = await lambdaClient.createFunction({
            FunctionName: lambdaName,
            Runtime: "nodejs22.x",
            Role: lambdaRoleArn,
            Handler: "index.handler",
            Code: { ZipFile: await fs.readFile(zipFilePath) },
            Description: "Hot Updater Lambda@Edge function",
            Publish: true,
          });

          functionArn.arn = createResp.FunctionArn || null;
          functionArn.version = createResp.Version || "1";
          return `Created Lambda "${lambdaName}" function`;
        } catch (error) {
          // Update if function already exists
          if (
            error instanceof Error &&
            error.name === "ResourceConflictException"
          ) {
            message(
              `Function "${lambdaName}" already exists. Updating function code...`,
            );

            const updateResp = await lambdaClient.updateFunctionCode({
              FunctionName: lambdaName,
              ZipFile: await fs.readFile(zipFilePath),
              Publish: true,
            });
            functionArn.arn = updateResp.FunctionArn || null;
            functionArn.version = updateResp.Version || "1";
          } else {
            // Pass through other errors
            if (error instanceof Error) {
              p.log.error(
                `Failed to create or update Lambda function: ${error.message}`,
              );
            }
            throw error;
          }
          return `Updated Lambda "${lambdaName}" function`;
        } finally {
          void removeTmpDir();
          void fs.rm(zipFilePath, { force: true });
        }
      },
    },
    {
      title: "Waiting for Lambda function to become Active",
      task: async () => {
        // Lambda ARN should be "unqualified ARN" + :version
        // ex) "arn:aws:lambda:us-east-1:123456789012:function:hot-updater-edge:2"
        const qualifiedName = `${lambdaName}:${functionArn.version}`;

        // Check repeatedly until state becomes Active
        while (true) {
          const resp = await lambdaClient.getFunctionConfiguration({
            FunctionName: qualifiedName,
          });
          if (resp.State === "Active") {
            return "Lambda function is now active";
          }

          if (resp.State === "Failed") {
            // Stop deployment if Lambda is in Failed state
            throw new Error(
              `Lambda function is in a Failed state. Reason: ${resp.StateReason}`,
            );
          }

          // Wait before retrying
          await new Promise((r) => setTimeout(r, 2000));
        }
      },
    },
  ]);

  if (!functionArn.arn || !functionArn.version) {
    throw new Error("Failed to create or update Lambda function");
  }

  // 5. Set Qualified ARN for Lambda@Edge
  //    (In case version is not automatically appended from createFunction result)
  if (!functionArn.arn.endsWith(`:${functionArn.version}`)) {
    functionArn.arn = `${functionArn.arn}:${functionArn.version}`;
  }
  p.log.info(`Using Lambda ARN: ${functionArn.arn}`);

  return { lambdaName, functionArn: functionArn.arn };
};

export const createCloudFrontDistribution = async (
  credentials:
    | {
        accessKeyId: string;
        secretAccessKey: string;
      }
    | undefined,
  region: string,
  bucketName: string,
  functionArn: string,
): Promise<{
  distributionId: string;
  distributionDomain: string;
}> => {
  const { SDK } = await import("@hot-updater/aws/sdk");
  const Cloudfront = SDK.CloudFront.CloudFront;
  const cloudfrontClient = new Cloudfront({ region, credentials });

  const bucketDomain = `${bucketName}.s3.${region}.amazonaws.com`;

  const matchingDistributions: Array<{ Id: string; DomainName: string }> = [];
  try {
    const listResp = await cloudfrontClient.listDistributions({});
    const items = listResp.DistributionList?.Items || [];
    for (const dist of items) {
      const origins = dist.Origins?.Items || [];
      if (origins.some((origin) => origin.DomainName === bucketDomain)) {
        matchingDistributions.push({
          Id: dist.Id!,
          DomainName: dist.DomainName!,
        });
      }
    }
  } catch (error) {
    console.error("Error listing CloudFront distributions:", error);
  }
  let selectedDistribution: { Id: string; DomainName: string } | null = null;
  if (matchingDistributions.length === 1) {
    selectedDistribution = matchingDistributions[0]!;
  } else if (matchingDistributions.length > 1) {
    const selectedDistributionStr = await p.select({
      message:
        "Multiple CloudFront distributions found. Please select one to use:",
      options: matchingDistributions.map((dist) => ({
        value: JSON.stringify(dist),
        label: `${dist.Id} (${dist.DomainName})`,
      })),
    });
    if (p.isCancel(selectedDistributionStr)) process.exit(0);
    selectedDistribution = JSON.parse(selectedDistributionStr);
  }

  const newOverrides: Partial<DistributionConfig> = {
    Origins: {
      Quantity: 1,
      Items: [
        {
          Id: bucketName,
          DomainName: bucketDomain,
          S3OriginConfig: {
            OriginAccessIdentity: "",
          },
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
            LambdaFunctionARN: functionArn,
          },
        ],
      },
      ForwardedValues: {
        QueryString: false,
        Cookies: { Forward: "none" },
      },
      MinTTL: 0,
    },
    CacheBehaviors: {
      Quantity: 1,
      Items: [
        {
          PathPattern: "/api/*",
          TargetOriginId: bucketName,
          ViewerProtocolPolicy: "redirect-to-https",
          LambdaFunctionAssociations: {
            Quantity: 1,
            Items: [
              {
                EventType: "viewer-request",
                LambdaFunctionARN: functionArn,
              },
            ],
          },
          MinTTL: 0,
          DefaultTTL: 0,
          MaxTTL: 0,
          ForwardedValues: {
            QueryString: false,
            Cookies: { Forward: "none" },
            Headers: {
              Quantity: 3,
              Items: [
                "x-bundle-id",
                "x-app-version",
                "x-app-platform",
                "x-min-bundle-id",
                "x-stage",
              ],
            },
          },
        },
      ],
    },
  };

  if (selectedDistribution) {
    p.log.success(
      `Existing CloudFront distribution selected. Distribution ID: ${selectedDistribution.Id}.`,
    );
    try {
      const { DistributionConfig, ETag } =
        await cloudfrontClient.getDistributionConfig({
          Id: selectedDistribution.Id,
        });

      const finalConfig = merge(DistributionConfig ?? {}, newOverrides);
      await cloudfrontClient.updateDistribution({
        Id: selectedDistribution.Id,
        IfMatch: ETag,
        DistributionConfig: finalConfig as DistributionConfig,
      });
      p.log.success(
        "CloudFront distribution updated with new Lambda function ARN.",
      );
      await cloudfrontClient.createInvalidation({
        DistributionId: selectedDistribution.Id,
        InvalidationBatch: {
          CallerReference: dayjs().format(),
          Paths: {
            Quantity: 1,
            Items: ["/*"],
          },
        },
      });
      p.log.success("Cache invalidation request completed.");
      return {
        distributionId: selectedDistribution.Id,
        distributionDomain: selectedDistribution.DomainName,
      };
    } catch (err) {
      p.log.error(
        `Failed to update CloudFront distribution: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      throw err;
    }
  }

  const finalDistributionConfig: DistributionConfig = {
    CallerReference: dayjs().format(),
    Comment: "Hot Updater CloudFront distribution",
    Enabled: true,
    Origins: {
      Quantity: 1,
      Items: [
        {
          Id: bucketName,
          DomainName: bucketDomain,
          S3OriginConfig: {
            OriginAccessIdentity: "",
          },
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
            LambdaFunctionARN: functionArn,
          },
        ],
      },
      ForwardedValues: {
        QueryString: false,
        Cookies: { Forward: "none" },
      },
      MinTTL: 0,
    },
    CacheBehaviors: {
      Quantity: 1,
      Items: [
        {
          PathPattern: "/api/*",
          TargetOriginId: bucketName,
          ViewerProtocolPolicy: "redirect-to-https",
          LambdaFunctionAssociations: {
            Quantity: 1,
            Items: [
              {
                EventType: "viewer-request",
                LambdaFunctionARN: functionArn,
              },
            ],
          },
          MinTTL: 0,
          DefaultTTL: 0,
          MaxTTL: 0,
          ForwardedValues: {
            QueryString: false,
            Cookies: { Forward: "none" },
            Headers: {
              Quantity: 3,
              Items: [
                "x-bundle-id",
                "x-app-version",
                "x-app-platform",
                "x-min-bundle-id",
                "x-stage",
              ],
            },
          },
        },
      ],
    },
    DefaultRootObject: "index.html",
    ViewerCertificate: {
      CloudFrontDefaultCertificate: true,
    },
    Restrictions: {
      GeoRestriction: {
        RestrictionType: "none",
        Quantity: 0,
      },
    },
    PriceClass: "PriceClass_All",
    Aliases: {
      Quantity: 0,
      Items: [],
    },
  };

  try {
    const distResp = await cloudfrontClient.createDistribution({
      DistributionConfig: finalDistributionConfig,
    });
    const distributionId = distResp.Distribution?.Id!;
    const distributionDomain = distResp.Distribution?.DomainName!;
    p.log.success(
      `Created new CloudFront distribution. Distribution ID: ${distributionId}`,
    );
    let retryCount = 0;
    await p.tasks([
      {
        title: "Waiting for CloudFront distribution to complete...",
        task: async (message) => {
          while (retryCount < 600) {
            try {
              const status = await cloudfrontClient.getDistribution({
                Id: distributionId,
              });
              if (status.Distribution?.Status === "Deployed") {
                return "CloudFront distribution deployment completed.";
              }
              throw new Error("Retry");
            } catch (err) {
              if (retryCount++ >= 5) {
                message(
                  `CloudFront distribution is still in progress. This may take few minutes. (${retryCount})`,
                );
              }
              await delay(1000);
            }
          }
          p.log.error("CloudFront distribution deployment timed out.");
          process.exit(1);
        },
      },
    ]);
    return { distributionId, distributionDomain };
  } catch (error) {
    p.log.error(
      `CloudFront distribution creation failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    throw error;
  }
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

  let credentials:
    | {
        accessKeyId: string;
        secretAccessKey: string;
        sessionToken?: string;
      }
    | undefined = undefined;

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

  // Create S3 client
  const S3 = SDK.S3.S3;

  const s3Client = new S3({ region: "us-east-1", credentials });
  const availableBuckets: { name: string; region: string }[] = [];
  try {
    await p.tasks([
      {
        title: "Checking S3 Buckets...",
        task: async () => {
          const buckets = await s3Client.listBuckets({});
          const bucketsWithRegion = await Promise.allSettled(
            (buckets.Buckets ?? [])
              .filter((bucket) => bucket.Name)
              .map(async (bucket) => {
                const { LocationConstraint: region } =
                  await s3Client.getBucketLocation({
                    Bucket: bucket.Name!,
                  });

                return {
                  name: bucket.Name!,
                  region: region as BucketLocationConstraint,
                };
              }),
          );

          availableBuckets.push(
            ...bucketsWithRegion
              .map((bucket) =>
                bucket.status === "fulfilled" ? bucket.value : null,
              )
              .filter((bucket) => bucket !== null),
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
        label: `${bucket.name} (${bucket.region})`,
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

  let region: BucketLocationConstraint = availableBuckets.find(
    (bucket) => bucket.name === bucketName,
  )?.region as BucketLocationConstraint;

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

    try {
      // Enter region for AWS S3 bucket creation
      const $region = await p.select({
        message: "Enter AWS region for the S3 bucket",
        options: Object.values(SDK.S3.BucketLocationConstraint).map((r) => ({
          label: `${r} (${regionLocationMap[r]})` as string,
          value: r as string,
        })),
      });
      if (p.isCancel($region)) {
        process.exit(1);
      }

      region = $region as BucketLocationConstraint;

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

  p.log.info(`Selected S3 Bucket: ${bucketName} (${region})`);

  const lambdaRoleArn = await createOrSelectIamRole({ region, credentials });

  // Deploy Lambda@Edge function (us-east-1)
  const { functionArn } = await deployLambdaEdge({
    region,
    bucketName,
    credentials,
    lambdaRoleArn,
  });

  // Create CloudFront distribution
  const { distributionDomain } = await createCloudFrontDistribution(
    credentials,
    region,
    bucketName,
    functionArn,
  );

  // Create config file and environment variable file
  if (mode === "sso") {
    await fs.writeFile("hot-updater.config.ts", CONFIG_TEMPLATE_WITH_SESSION);
  } else {
    await fs.writeFile("hot-updater.config.ts", CONFIG_TEMPLATE);
  }

  const comment =
    mode === "account"
      ? "The current key may have excessive permissions. Update it with an S3FullAccess-only key."
      : "This key was generated via SSO login and may expire. Update it with an S3FullAccess-only key.";
  await makeEnv({
    HOT_UPDATER_S3_BUCKET_NAME: bucketName,
    HOT_UPDATER_S3_REGION: region,
    HOT_UPDATER_S3_ACCESS_KEY_ID: {
      comment,
      value: credentials?.accessKeyId ?? "",
    },
    HOT_UPDATER_S3_SECRET_ACCESS_KEY: {
      comment,
      value: credentials?.secretAccessKey ?? "",
    },
    ...(mode === "sso" && {
      HOT_UPDATER_S3_SESSION_TOKEN: credentials.sessionToken,
    }),
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
    `Next step: ${link("https://gronxb.github.io/hot-updater/guide/providers/3_aws-s3-lambda-edge.html#step-4-changeenv-file-optional")}`,
  );
  p.log.success("Done! 🎉");
};
