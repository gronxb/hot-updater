import { createHash } from "node:crypto";

import { IAM } from "@aws-sdk/client-iam";
import { STS } from "@aws-sdk/client-sts";
import { p } from "@hot-updater/cli-tools";

import {
  DYNAMODB_ANALYTICS_PARTITION,
  DYNAMODB_CHANNEL_NAME_PARTITION,
  DYNAMODB_CHANNEL_PARTITION,
  DYNAMODB_CLIENT_ACCESS_KEY_HASH_PARTITION,
  DYNAMODB_CLIENT_ACCESS_KEY_PARTITION,
  DYNAMODB_UPDATE_INDEX_NAME,
} from "../src/dynamoDB";

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

  private async ensureManagedPolicies(iamClient: IAM, roleName: string) {
    const attachedPolicies = await iamClient.listAttachedRolePolicies({
      RoleName: roleName,
    });

    const attachedPolicyArns = new Set(
      (attachedPolicies.AttachedPolicies ?? []).map(
        (policy) => policy.PolicyArn,
      ),
    );

    const requiredPolicyArns = [
      "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole",
    ];

    for (const policyArn of requiredPolicyArns) {
      if (!attachedPolicyArns.has(policyArn)) {
        await iamClient.attachRolePolicy({
          RoleName: roleName,
          PolicyArn: policyArn,
        });
      }
    }
  }

  private async ensureDynamoDBPolicy(
    iamClient: IAM,
    roleName: string,
    accountId: string,
    tableName: string,
  ): Promise<void> {
    const tableArn = `arn:aws:dynamodb:${this.region}:${accountId}:table/${tableName}`;
    await iamClient.putRolePolicy({
      PolicyDocument: JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          {
            Action: ["dynamodb:Query"],
            Effect: "Allow",
            Resource: [`${tableArn}/index/${DYNAMODB_UPDATE_INDEX_NAME}`],
          },
          {
            Action: [
              "dynamodb:BatchGetItem",
              "dynamodb:DeleteItem",
              "dynamodb:GetItem",
              "dynamodb:PutItem",
              "dynamodb:Query",
              "dynamodb:TransactWriteItems",
              "dynamodb:UpdateItem",
            ],
            Condition: {
              "ForAllValues:StringEquals": {
                "dynamodb:LeadingKeys": [
                  "_hot-updater",
                  "bundles",
                  "bundle_patches",
                  DYNAMODB_CHANNEL_PARTITION,
                  DYNAMODB_CHANNEL_NAME_PARTITION,
                  DYNAMODB_ANALYTICS_PARTITION,
                  DYNAMODB_CLIENT_ACCESS_KEY_PARTITION,
                  DYNAMODB_CLIENT_ACCESS_KEY_HASH_PARTITION,
                ],
              },
            },
            Effect: "Allow",
            Resource: [tableArn],
          },
        ],
      }),
      PolicyName: "HotUpdaterDynamoDBReadAccess",
      RoleName: roleName,
    });
  }

  private async ensureS3Policy(
    iamClient: IAM,
    roleName: string,
    bucketName: string,
  ): Promise<void> {
    await iamClient.putRolePolicy({
      PolicyDocument: JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          {
            Action: ["s3:ListBucket"],
            Effect: "Allow",
            Resource: [`arn:aws:s3:::${bucketName}`],
          },
          {
            Action: ["s3:GetObject"],
            Effect: "Allow",
            Resource: [`arn:aws:s3:::${bucketName}/*`],
          },
        ],
      }),
      PolicyName: "HotUpdaterS3ReadAccess",
      RoleName: roleName,
    });
  }

  private async ensureSsmPolicy(
    iamClient: IAM,
    roleName: string,
    accountId: string,
    parameterName: string,
  ): Promise<void> {
    const parameterPath = parameterName.replace(/^\/+/, "");
    await iamClient.putRolePolicy({
      PolicyDocument: JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Action: ["ssm:GetParameter"],
            Resource: `arn:aws:ssm:${this.region}:${accountId}:parameter/${parameterPath}`,
          },
        ],
      }),
      PolicyName: "HotUpdaterSSMAccess",
      RoleName: roleName,
    });
  }

  async createOrSelectRole(options: {
    readonly bucketName: string;
    readonly dynamodbTableName: string;
    readonly lambdaName: string;
    readonly ssmParameterName: string;
  }): Promise<string> {
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
    const installationId = createHash("sha256")
      .update(options.lambdaName)
      .digest("hex")
      .slice(0, 16);
    const roleName = `hot-updater-edge-${installationId}`;

    try {
      const { Role: existingRole } = await iamClient.getRole({
        RoleName: roleName,
      });
      if (existingRole?.Arn) {
        await this.ensureManagedPolicies(iamClient, roleName);
        await this.ensureS3Policy(iamClient, roleName, options.bucketName);
        await this.ensureSsmPolicy(
          iamClient,
          roleName,
          accountId,
          options.ssmParameterName,
        );
        await this.ensureDynamoDBPolicy(
          iamClient,
          roleName,
          accountId,
          options.dynamodbTableName,
        );
        p.log.info(
          `Using existing IAM role: ${roleName} (${existingRole.Arn})`,
        );
        return existingRole.Arn;
      }
    } catch (error) {
      if (!(error instanceof Error && error.name === "NoSuchEntityException")) {
        throw error;
      }
      // Role does not exist so create it
      try {
        const createRoleResp = await iamClient.createRole({
          RoleName: roleName,
          AssumeRolePolicyDocument: assumeRolePolicyDocument,
          Description: `Role for Hot Updater Lambda@Edge ${options.lambdaName}`,
        });
        if (!createRoleResp.Role?.Arn) {
          throw new Error("Failed to create IAM role: No ARN returned");
        }
        const lambdaRoleArn = createRoleResp.Role.Arn;
        p.log.info(`Created IAM role: ${roleName} (${lambdaRoleArn})`);

        // Attach required managed policies
        await this.ensureManagedPolicies(iamClient, roleName);
        p.log.info(`Attached managed policies to ${roleName}`);

        await this.ensureS3Policy(iamClient, roleName, options.bucketName);
        await this.ensureSsmPolicy(
          iamClient,
          roleName,
          accountId,
          options.ssmParameterName,
        );
        p.log.info(`Added resource-scoped policies to ${roleName}`);

        await this.ensureDynamoDBPolicy(
          iamClient,
          roleName,
          accountId,
          options.dynamodbTableName,
        );
        p.log.info(`Added DynamoDB read policy to ${roleName}`);

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
