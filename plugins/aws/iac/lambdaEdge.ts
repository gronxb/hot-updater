import fs from "fs/promises";
import os from "os";
import path from "path";

import { Lambda } from "@aws-sdk/client-lambda";
import {
  copyDirToTmp,
  createZip,
  getCwd,
  InitError,
  p,
  transformEnv,
} from "@hot-updater/cli-tools";

import { buildLambdaFromDefinition } from "./managedLambda";

const LAMBDA_MEMORY_SIZE = 256;
/** Lambda@Edge's limit on an origin-request function's zipped code. */
export const LAMBDA_EDGE_MAX_ZIP_BYTES = 50 * 1024 * 1024;

const megabytes = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

/**
 * Zips `dir` to `outfile`, refusing code Lambda@Edge would reject;
 * `definition` names the server definition it was bundled from.
 */
const zipLambda = async (dir: string, outfile: string, definition?: string) => {
  await createZip({ outfile, targetDir: dir });
  const { size } = await fs.stat(outfile);
  if (size > LAMBDA_EDGE_MAX_ZIP_BYTES) {
    throw new InitError(
      `${definition === undefined ? "The Lambda@Edge function" : `${definition} bundles into a Lambda@Edge function that`} zips to ${megabytes(size)}, over Lambda@Edge's ${megabytes(LAMBDA_EDGE_MAX_ZIP_BYTES)} limit for origin-request functions. Remove large dependencies from its plugins, or host the server yourself.`,
    );
  }
};

/** The function's code, staged in a temporary directory. */
export interface StagedLambda {
  readonly dir: string;
  readonly remove: () => Promise<void>;
}

/**
 * Stages the function's code: the prebuilt function, or the project's
 * server definition bundled with the function's runtime module. A
 * definition that cannot be bundled, or whose code zips past Lambda@Edge's
 * limit, fails here, before init changes any resource.
 */
export const stageLambda = async (
  definition: string | undefined,
): Promise<StagedLambda> => {
  if (definition === undefined) {
    const { tmpDir, removeTmpDir } = await copyDirToTmp(
      path.dirname(require.resolve("@hot-updater/aws/lambda")),
    );
    return { dir: tmpDir, remove: removeTmpDir };
  }
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hot-updater-lambda-"));
  const remove = () => fs.rm(dir, { recursive: true, force: true });
  try {
    await buildLambdaFromDefinition({
      definition,
      packageRoot: path.dirname(
        require.resolve("@hot-updater/aws/package.json"),
      ),
      projectRoot: getCwd(),
      lambdaDir: dir,
    });
    const zip = `${dir}.zip`;
    try {
      await zipLambda(
        dir,
        zip,
        path.relative(getCwd(), definition) || definition,
      );
    } finally {
      await fs.rm(zip, { force: true });
    }
    return { dir, remove };
  } catch (error) {
    await remove();
    throw error;
  }
};
const LAMBDA_TIMEOUT_SECONDS = 10;
const LAMBDA_ROLE_PROPAGATION_MAX_ATTEMPTS = 10;
const LAMBDA_ROLE_PROPAGATION_RETRY_DELAY_MS = 2000;

const isLambdaRolePropagationError = (error: unknown): error is Error =>
  error instanceof Error &&
  error.name === "InvalidParameterValueException" &&
  /role defined for the function cannot be assumed by Lambda/i.test(
    error.message,
  );

const createFunctionWithRolePropagationRetry = async <Result>(
  createFunction: () => Promise<Result>,
  message: (value: string) => void,
): Promise<Result> => {
  for (
    let attempt = 1;
    attempt <= LAMBDA_ROLE_PROPAGATION_MAX_ATTEMPTS;
    attempt++
  ) {
    try {
      return await createFunction();
    } catch (error) {
      if (
        !isLambdaRolePropagationError(error) ||
        attempt === LAMBDA_ROLE_PROPAGATION_MAX_ATTEMPTS
      ) {
        throw error;
      }
      message("Waiting for IAM role to become assumable by Lambda...");
      await new Promise((resolve) =>
        setTimeout(resolve, LAMBDA_ROLE_PROPAGATION_RETRY_DELAY_MS),
      );
    }
  }

  throw new Error("Failed to create Lambda function");
};

export class LambdaEdgeDeployer {
  private credentials: { accessKeyId: string; secretAccessKey: string };

  constructor(credentials: { accessKeyId: string; secretAccessKey: string }) {
    this.credentials = credentials;
  }

  private async waitForUpdate(
    lambdaClient: Lambda,
    lambdaName: string,
  ): Promise<void> {
    while (true) {
      try {
        const status = await lambdaClient.getFunctionConfiguration({
          FunctionName: lambdaName,
        });
        if (status.LastUpdateStatus === "Successful") return;
        if (status.LastUpdateStatus === "Failed") {
          throw new Error(
            `Lambda update failed: ${status.LastUpdateStatusReason}`,
          );
        }
      } catch (error) {
        if (
          !(error instanceof Error) ||
          error.name !== "ResourceConflictException"
        ) {
          throw error;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }

  /** Deploys `staged`, which it removes, with the resources init set up. */
  async deploy(
    lambdaRoleArn: string,
    lambdaName: string,
    config: {
      bucketName: string;
      dynamodbRegion: string;
      dynamodbTableName: string;
      publicKeyId: string;
      ssmParameterName: string;
      ssmRegion: string;
    },
    staged: StagedLambda,
  ): Promise<{ lambdaName: string; functionArn: string }> {
    const cwd = getCwd();

    // Transform Lambda code with CloudFront key pair details and SSM config
    const indexPath = path.join(staged.dir, "index.cjs");
    const code = transformEnv(indexPath, {
      CLOUDFRONT_KEY_PAIR_ID: config.publicKeyId,
      DYNAMODB_REGION: config.dynamodbRegion,
      DYNAMODB_TABLE_NAME: config.dynamodbTableName,
      SSM_PARAMETER_NAME: config.ssmParameterName,
      SSM_REGION: config.ssmRegion,
      S3_BUCKET_NAME: config.bucketName,
    });
    await fs.writeFile(indexPath, code);

    const lambdaClient = new Lambda({
      region: "us-east-1",
      credentials: this.credentials,
    });
    const functionArn: { arn: string | null; version: string | null } = {
      arn: null,
      version: null,
    };
    const zipFilePath = path.join(cwd, `${lambdaName}.zip`);

    await p.tasks([
      {
        title: "Compressing Lambda code to zip",
        task: async () => {
          try {
            await zipLambda(staged.dir, zipFilePath);
            return "Compressed Lambda code to zip";
          } catch (error) {
            throw new Error(
              `Failed to create zip archive of Lambda function code: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        },
      },
      {
        title: "Creating or Updating Lambda function",
        task: async (message) => {
          try {
            const zipFile = await fs.readFile(zipFilePath);
            const createResp = await createFunctionWithRolePropagationRetry(
              () =>
                lambdaClient.createFunction({
                  FunctionName: lambdaName,
                  Runtime: "nodejs22.x",
                  Role: lambdaRoleArn,
                  Handler: "index.handler",
                  Code: { ZipFile: zipFile },
                  Description: "Hot Updater Lambda@Edge function",
                  MemorySize: LAMBDA_MEMORY_SIZE,
                  Publish: true,
                  Timeout: LAMBDA_TIMEOUT_SECONDS,
                }),
              message,
            );
            functionArn.arn = createResp.FunctionArn || null;
            functionArn.version = createResp.Version || "1";
            return `Created Lambda "${lambdaName}" function`;
          } catch (error) {
            if (
              error instanceof Error &&
              error.name === "ResourceConflictException"
            ) {
              message(
                `Function "${lambdaName}" already exists. Updating function code...`,
              );
              await lambdaClient.updateFunctionCode({
                FunctionName: lambdaName,
                ZipFile: await fs.readFile(zipFilePath),
                Publish: false,
              });
              message("Waiting for Lambda function update to complete...");
              await this.waitForUpdate(lambdaClient, lambdaName);
              await lambdaClient.updateFunctionConfiguration({
                FunctionName: lambdaName,
                MemorySize: LAMBDA_MEMORY_SIZE,
                Role: lambdaRoleArn,
                Timeout: LAMBDA_TIMEOUT_SECONDS,
              });
              await this.waitForUpdate(lambdaClient, lambdaName);
              const published = await lambdaClient.publishVersion({
                FunctionName: lambdaName,
              });
              functionArn.arn = published.FunctionArn || null;
              functionArn.version = published.Version || null;
            } else {
              if (error instanceof Error) {
                p.log.error(
                  `Failed to create or update Lambda function: ${error.message}`,
                );
              }
              throw error;
            }
            return `Updated Lambda "${lambdaName}" function`;
          } finally {
            void staged.remove();
            void fs.rm(zipFilePath, { force: true });
          }
        },
      },
      {
        title: "Waiting for Lambda function to become Active",
        task: async () => {
          const qualifiedName = `${lambdaName}:${functionArn.version}`;
          while (true) {
            const resp = await lambdaClient.getFunctionConfiguration({
              FunctionName: qualifiedName,
            });
            if (resp.State === "Active") {
              return "Lambda function is now active";
            }
            if (resp.State === "Failed") {
              throw new Error(
                `Lambda function is in a Failed state. Reason: ${resp.StateReason}`,
              );
            }
            await new Promise((r) => setTimeout(r, 2000));
          }
        },
      },
    ]);

    if (!functionArn.arn || !functionArn.version) {
      throw new Error("Failed to create or update Lambda function");
    }
    if (!functionArn.arn.endsWith(`:${functionArn.version}`)) {
      functionArn.arn = `${functionArn.arn}:${functionArn.version}`;
    }
    p.log.info(`Using Lambda ARN: ${functionArn.arn}`);
    return { lambdaName, functionArn: functionArn.arn };
  }
}
