import path from "path";
import { Lambda } from "@aws-sdk/client-lambda";
import * as p from "@clack/prompts";
import {
  copyDirToTmp,
  createZip,
  getCwd,
  transformEnv,
} from "@hot-updater/plugin-core";
import {} from "execa";
import fs from "fs/promises";
import {getTagsAsKeyValuePairs, tags} from "./tags";

export class LambdaEdgeDeployer {
  private credentials: { accessKeyId: string; secretAccessKey: string };

  constructor(credentials: { accessKeyId: string; secretAccessKey: string }) {
    this.credentials = credentials;
  }

  async deploy(
    lambdaRoleArn: string,
    keyPair: { publicKey: string; privateKey: string },
  ): Promise<{ lambdaName: string; functionArn: string }> {
    const cwd = getCwd();
    const lambdaName = await p.text({
      message: "Enter the name of the Lambda@Edge function",
      defaultValue: "hot-updater-edge",
      placeholder: "hot-updater-edge",
    });
    if (p.isCancel(lambdaName)) process.exit(1);

    const lambdaPath = require.resolve("@hot-updater/aws/lambda");
    const lambdaDir = path.dirname(lambdaPath);
    const { tmpDir, removeTmpDir } = await copyDirToTmp(lambdaDir);

    // Transform Lambda code with CloudFront key pair details
    const indexPath = path.join(tmpDir, "index.cjs");
    const originalCode = await fs.readFile(indexPath, "utf-8");
    const code = await transformEnv(originalCode, {
      CLOUDFRONT_KEY_PAIR_ID: keyPair.publicKey,
      CLOUDFRONT_PRIVATE_KEY_BASE64: Buffer.from(keyPair.privateKey).toString(
        "base64",
      ),
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
            const createResp = await lambdaClient.createFunction({
              FunctionName: lambdaName,
              Runtime: "nodejs22.x",
              Role: lambdaRoleArn,
              Handler: "index.handler",
              Code: { ZipFile: await fs.readFile(zipFilePath) },
              Description: "Hot Updater Lambda@Edge function",
              Publish: true,
              Timeout: 10,
              Tags: tags
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
              const updateResp = await lambdaClient.updateFunctionCode({
                FunctionName: lambdaName,
                ZipFile: await fs.readFile(zipFilePath),
                Publish: true,
              });
              message("Waiting for Lambda function update to complete...");
              let isUpdateComplete = false;
              while (!isUpdateComplete) {
                try {
                  const status = await lambdaClient.getFunctionConfiguration({
                    FunctionName: lambdaName,
                  });
                  if (status.LastUpdateStatus === "Successful") {
                    isUpdateComplete = true;
                  } else if (status.LastUpdateStatus === "Failed") {
                    throw new Error(
                      `Lambda update failed: ${status.LastUpdateStatusReason}`,
                    );
                  } else {
                    await new Promise((resolve) => setTimeout(resolve, 2000));
                  }
                } catch (err) {
                  if (
                    err instanceof Error &&
                    err.name === "ResourceConflictException"
                  ) {
                    await new Promise((resolve) => setTimeout(resolve, 2000));
                  } else {
                    throw err;
                  }
                }
              }
              try {
                await lambdaClient.updateFunctionConfiguration({
                  FunctionName: lambdaName,
                  MemorySize: 256,
                  Timeout: 10,
                });
              } catch (error) {
                p.log.error(
                  `Failed to update Lambda configuration: ${error instanceof Error ? error.message : String(error)}`,
                );
              }
              functionArn.arn = updateResp.FunctionArn || null;
              functionArn.version = updateResp.Version || "1";
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
