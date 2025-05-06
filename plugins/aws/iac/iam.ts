import { IAM } from "@aws-sdk/client-iam";
import * as p from "@clack/prompts";
import {getTagsAsKeyValuePairs} from "./tags";

export class IAMManager {
  private region: string;
  private credentials: { accessKeyId: string; secretAccessKey: string };

  constructor(
    region: string,
    credentials: { accessKeyId: string; secretAccessKey: string },
  ) {
    this.region = region;
    this.credentials = credentials;
  }

  async createOrSelectRole(): Promise<string> {
    const iamClient = new IAM({
      region: this.region,
      credentials: this.credentials,
    });
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
      const { Role: existingRole } = await iamClient.getRole({
        RoleName: roleName,
      });
      if (existingRole?.Arn) {
        p.log.info(
          `Using existing IAM role: ${roleName} (${existingRole.Arn})`,
        );
        return existingRole.Arn;
      }
    } catch (error) {
      // Role does not exist so create it
      try {
        const createRoleResp = await iamClient.createRole({
          RoleName: roleName,
          AssumeRolePolicyDocument: assumeRolePolicyDocument,
          Description: "Role for Lambda@Edge to access S3",
          Tags: getTagsAsKeyValuePairs()
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
        p.log.info(`Attached required policies to ${roleName}`);

        return lambdaRoleArn;
      } catch (createError) {
        if (createError instanceof Error) {
          p.log.error(`Error setting up IAM role: ${createError.message}`);
        }
        process.exit(1);
      }
    }
    throw new Error("Failed to create or get IAM role");
  }
}
