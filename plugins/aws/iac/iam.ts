import { createHash } from "node:crypto";

import { IAM } from "@aws-sdk/client-iam";
import { STS } from "@aws-sdk/client-sts";
import { p } from "@hot-updater/cli-tools";
import {
  aggregateBatchingModule,
  type PluginTables,
  resolveSchema,
  SETTINGS_TABLE,
  toolingTargetOf,
} from "@hot-updater/server/database";

import { plugins as packagePlugins } from "../src/plugins";

/**
 * The partitions the managed server's items use: each table's rows of core
 * and `plugins`, the plugins the server runs, and its index items after
 * `#`, the log and lease tables of batched aggregates included.
 */
export const dynamoDBLeadingKeys = (
  plugins: readonly PluginTables[] = packagePlugins,
): string[] =>
  [
    ...toolingTargetOf(plugins).schema.tables,
    ...resolveSchema([aggregateBatchingModule]).tables,
    SETTINGS_TABLE,
  ].flatMap(({ name }) => [name, `${name}#*`]);

export const buildDynamoDBPolicy = (
  region: string,
  accountId: string,
  tableName: string,
  plugins: readonly PluginTables[] = packagePlugins,
) => {
  const tableArn = `arn:aws:dynamodb:${region}:${accountId}:table/${tableName}`;
  return {
    Version: "2012-10-17",
    Statement: [
      {
        // The key-value store reads with BatchGetItem and Query, writes with
        // TransactWriteItems, and deletes consumed aggregate log rows with
        // BatchWriteItem.
        Action: [
          "dynamodb:BatchGetItem",
          "dynamodb:BatchWriteItem",
          "dynamodb:ConditionCheckItem",
          "dynamodb:DeleteItem",
          "dynamodb:GetItem",
          "dynamodb:PutItem",
          "dynamodb:Query",
          "dynamodb:TransactWriteItems",
          "dynamodb:UpdateItem",
        ],
        Condition: {
          "ForAllValues:StringLike": {
            "dynamodb:LeadingKeys": dynamoDBLeadingKeys(plugins),
          },
        },
        Effect: "Allow",
        Resource: [tableArn],
      },
    ],
  };
};

export const buildS3Policy = (bucketName: string) => {
  return {
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
  };
};

export const buildSsmPolicy = (
  region: string,
  accountId: string,
  parameterName: string,
) => {
  const parameterPath = parameterName.replace(/^\/+/, "");
  return {
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Action: ["ssm:GetParameter"],
        Resource: `arn:aws:ssm:${region}:${accountId}:parameter/${parameterPath}`,
      },
    ],
  };
};

export const LAMBDA_EDGE_TRUST_POLICY = {
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
};

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
    plugins: readonly PluginTables[],
  ): Promise<void> {
    await iamClient.putRolePolicy({
      PolicyDocument: JSON.stringify(
        buildDynamoDBPolicy(this.region, accountId, tableName, plugins),
      ),
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
      PolicyDocument: JSON.stringify(buildS3Policy(bucketName)),
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
    await iamClient.putRolePolicy({
      PolicyDocument: JSON.stringify(
        buildSsmPolicy(this.region, accountId, parameterName),
      ),
      PolicyName: "HotUpdaterSSMAccess",
      RoleName: roleName,
    });
  }

  async createOrSelectRole(options: {
    readonly bucketName: string;
    readonly dynamodbTableName: string;
    readonly lambdaName: string;
    readonly ssmParameterName: string;
    /** The plugins the function runs, whose tables it may read and write. */
    readonly plugins: readonly PluginTables[];
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

    const assumeRolePolicyDocument = JSON.stringify(LAMBDA_EDGE_TRUST_POLICY);
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
          options.plugins,
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
          options.plugins,
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
