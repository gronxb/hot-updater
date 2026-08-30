import fs from "fs/promises";
import path from "path";

import { Lambda } from "@aws-sdk/client-lambda";
import {
  copyDirToTmp,
  createZip,
  getCwd,
  p,
  transformEnv,
} from "@hot-updater/cli-tools";

import { resolveLambdaDir } from "./lambdaAsset";

const LAMBDA_EDGE_MEMORY_SIZE = 256;
const LAMBDA_EDGE_TIMEOUT = 10;

const waitForFunctionUpdate = async (
  lambdaClient: Lambda,
  lambdaName: string,
) => {
  while (true) {
    try {
      const status = await lambdaClient.getFunctionConfiguration({
        FunctionName: lambdaName,
      });
      if (status.LastUpdateStatus === "Successful") {
        return;
      }
      if (status.LastUpdateStatus === "Failed") {
        throw new Error(
          `Lambda update failed: ${status.LastUpdateStatusReason}`,
        );
      }
    } catch (err) {
      if (!(err instanceof Error && err.name === "ResourceConflictException")) {
        throw err;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
};

export class LambdaEdgeDeployer {
  private credentials: { accessKeyId: string; secretAccessKey: string };

  constructor(credentials: { accessKeyId: string; secretAccessKey: string }) {
    this.credentials = credentials;
  }

  async deploy(
    lambdaRoleArn: string,
    lambdaName: string,
    config: {
      bucketName: string;
      publicKeyId: string;
      ssmParameterName: string;
      ssmRegion: string;
    },
  ): Promise<{ lambdaName: string; functionArn: string }> {
    const cwd = getCwd();

    const lambdaDir = resolveLambdaDir();
    const { tmpDir, removeTmpDir } = await copyDirToTmp(lambdaDir);

    // Transform Lambda code with CloudFront key pair details and SSM config
    const indexPath = path.join(tmpDir, "index.cjs");
    const code = transformEnv(indexPath, {
      CLOUDFRONT_KEY_PAIR_ID: config.publicKeyId,
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
            await createZip({ outfile: zipFilePath, targetDir: tmpDir });
            return "Compressed Lambda code to zip";
          } catch {
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
            const createResp = await lambdaClient.createFunction({
              FunctionName: lambdaName,
              Runtime: "nodejs22.x",
              Role: lambdaRoleArn,
              Handler: "index.handler",
              Code: { ZipFile: await fs.readFile(zipFilePath) },
              Description: "Hot Updater Lambda@Edge function",
              Publish: true,
              MemorySize: LAMBDA_EDGE_MEMORY_SIZE,
              Timeout: LAMBDA_EDGE_TIMEOUT,
            });
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
              // Publish only after the configuration is applied: a published
              // version is an immutable snapshot, so publishing here would pin
              // the previous deploy's memory/timeout.
              await lambdaClient.updateFunctionCode({
                FunctionName: lambdaName,
                ZipFile: await fs.readFile(zipFilePath),
                Publish: false,
              });
              message("Waiting for Lambda function update to complete...");
              await waitForFunctionUpdate(lambdaClient, lambdaName);

              await lambdaClient.updateFunctionConfiguration({
                FunctionName: lambdaName,
                MemorySize: LAMBDA_EDGE_MEMORY_SIZE,
                Timeout: LAMBDA_EDGE_TIMEOUT,
              });
              message("Waiting for Lambda configuration update to complete...");
              await waitForFunctionUpdate(lambdaClient, lambdaName);

              const publishResp = await lambdaClient.publishVersion({
                FunctionName: lambdaName,
              });
              functionArn.arn = publishResp.FunctionArn || null;
              functionArn.version = publishResp.Version || "1";
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
            void removeTmpDir();
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
