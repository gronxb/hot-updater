import { IAM } from "@aws-sdk/client-iam";
import { STS } from "@aws-sdk/client-sts";
import * as p from "@clack/prompts";

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
    const stsClient = new STS({
      region: this.region,
      credentials: this.credentials,
    });

    // Get AWS account ID for SSM policy
    const callerIdentity = await stsClient.getCallerIdentity({});
    const accountId = callerIdentity.Account;
    if (!accountId) {
      throw new Error("Failed to get AWS account ID");
    }

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

    // SSM GetParameter inline policy
    const ssmPolicyDocument = JSON.stringify({
      Version: "2012-10-17",
      Statement: [
        {
          Effect: "Allow",
          Action: ["ssm:GetParameter"],
          Resource: `arn:aws:ssm:*:${accountId}:parameter/hot-updater/*`,
        },
      ],
    });

    try {
      const { Role: existingRole } = await iamClient.getRole({
        RoleName: roleName,
      });
      if (existingRole?.Arn) {
        // Update inline policy for existing role
        try {
          await iamClient.putRolePolicy({
            RoleName: roleName,
            PolicyName: "HotUpdaterSSMAccess",
            PolicyDocument: ssmPolicyDocument,
          });
          p.log.info("Updated SSM access policy for existing IAM role");
        } catch (policyError) {
          p.log.warn("Failed to update SSM policy, continuing anyway");
        }
        p.log.info(
          `Using existing IAM role: ${roleName} (${existingRole.Arn})`,
        );
        return existingRole.Arn;
      }
    } catch {
      // Role does not exist so create it
      try {
        const createRoleResp = await iamClient.createRole({
          RoleName: roleName,
          AssumeRolePolicyDocument: assumeRolePolicyDocument,
          Description: "Role for Lambda@Edge to access S3 and SSM",
        });
        const lambdaRoleArn = createRoleResp.Role?.Arn!;
        p.log.info(`Created IAM role: ${roleName} (${lambdaRoleArn})`);

        // Attach required managed policies
        await iamClient.attachRolePolicy({
          RoleName: roleName,
          PolicyArn:
            "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole",
        });
        await iamClient.attachRolePolicy({
          RoleName: roleName,
          PolicyArn: "arn:aws:iam::aws:policy/AmazonS3ReadOnlyAccess",
        });
        p.log.info(`Attached managed policies to ${roleName}`);

        // Add inline policy for SSM access
        await iamClient.putRolePolicy({
          RoleName: roleName,
          PolicyName: "HotUpdaterSSMAccess",
          PolicyDocument: ssmPolicyDocument,
        });
        p.log.info(`Added SSM access inline policy to ${roleName}`);

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
