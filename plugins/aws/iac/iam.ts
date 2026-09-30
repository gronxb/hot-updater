import { createHash } from "node:crypto";

import { IAM } from "@aws-sdk/client-iam";
import { STS } from "@aws-sdk/client-sts";
import { p } from "@hot-updater/cli-tools";
import {
  aggregateBatchingModule,
  coreTarget,
  type PluginTables,
  resolveSchema,
  SETTINGS_TABLE,
  toolingTargetOf,
} from "@hot-updater/server/database";

import { plugins as packagePlugins } from "../src/plugins";

/** Each table's rows, and its index items after `#`. */
const partitionsOf = (tables: readonly { readonly name: string }[]) =>
  tables.flatMap(({ name }) => [name, `${name}#*`]);

/**
 * The partitions the managed server reads: the tables of core and
 * `plugins`, the plugins the server runs, the settings rows, and the log and
 * lease tables of batched aggregates.
 */
export const dynamoDBLeadingKeys = (
  plugins: readonly PluginTables[] = packagePlugins,
): string[] =>
  partitionsOf([
    ...toolingTargetOf(plugins).schema.tables,
    ...resolveSchema([aggregateBatchingModule]).tables,
    SETTINGS_TABLE,
  ]);

/**
 * The partitions the managed server writes: its plugins' tables and the
 * aggregate log. Core's tables and the settings rows change only through
 * the CLI, and third-party plugins share the function's role.
 */
export const dynamoDBWriteLeadingKeys = (
  plugins: readonly PluginTables[] = packagePlugins,
): string[] => {
  const core = new Set(coreTarget.schema.tables.map(({ name }) => name));
  return partitionsOf([
    ...toolingTargetOf(plugins).schema.tables.filter(
      ({ name }) => !core.has(name),
    ),
    ...resolveSchema([aggregateBatchingModule]).tables,
  ]);
};

/** The partitions a deployment reads and writes. */
export interface DynamoDBAccess {
  readonly read: readonly string[];
  readonly write: readonly string[];
}

const READ_ACTIONS = [
  "dynamodb:BatchGetItem",
  "dynamodb:ConditionCheckItem",
  "dynamodb:GetItem",
  "dynamodb:Query",
];

// The key-value store writes with TransactWriteItems and deletes consumed
// aggregate log rows with BatchWriteItem.
const WRITE_ACTIONS = [
  "dynamodb:BatchWriteItem",
  "dynamodb:DeleteItem",
  "dynamodb:PutItem",
  "dynamodb:TransactWriteItems",
  "dynamodb:UpdateItem",
];

const statementsOf = (
  prefix: string,
  tableArn: string,
  access: DynamoDBAccess,
) => [
  {
    Sid: `${prefix}Read`,
    Action: READ_ACTIONS,
    Condition: {
      "ForAllValues:StringLike": { "dynamodb:LeadingKeys": [...access.read] },
    },
    Effect: "Allow",
    Resource: [tableArn],
  },
  {
    Sid: `${prefix}Write`,
    Action: WRITE_ACTIONS,
    Condition: {
      "ForAllValues:StringLike": { "dynamodb:LeadingKeys": [...access.write] },
    },
    Effect: "Allow",
    Resource: [tableArn],
  },
];

const sameAccess = (left: DynamoDBAccess, right: DynamoDBAccess) =>
  [left.read, left.write].every(
    (keys, at) =>
      JSON.stringify([...keys].sort()) ===
      JSON.stringify([...[right.read, right.write][at]!].sort()),
  );

/**
 * The function's DynamoDB access: `plugins`' partitions, and while a deploy
 * rolls out, `previous`, the deployment it replaces, whose version the edges
 * keep running for minutes. The next deploy drops `previous`.
 */
export const buildDynamoDBPolicy = (
  region: string,
  accountId: string,
  tableName: string,
  plugins: readonly PluginTables[] = packagePlugins,
  previous?: DynamoDBAccess,
) => {
  const tableArn = `arn:aws:dynamodb:${region}:${accountId}:table/${tableName}`;
  const current = {
    read: dynamoDBLeadingKeys(plugins),
    write: dynamoDBWriteLeadingKeys(plugins),
  };
  return {
    Version: "2012-10-17",
    Statement: [
      ...statementsOf("HotUpdater", tableArn, current),
      ...(previous === undefined || sameAccess(previous, current)
        ? []
        : statementsOf("HotUpdaterPrevious", tableArn, previous)),
    ],
  };
};

type PolicyStatement = {
  readonly Sid?: string;
  readonly Action?: string | readonly string[];
  readonly Condition?: Record<string, Record<string, string | string[]>>;
};

/**
 * The access a policy document gives its current deployment, read back so
 * the next deploy keeps it while it rolls out. A policy from before the
 * split has one statement for both.
 */
export const dynamoDBAccessOf = (
  document: string,
): DynamoDBAccess | undefined => {
  const { Statement = [] } = JSON.parse(document) as {
    readonly Statement?: readonly PolicyStatement[];
  };
  const keysOf = (statement: PolicyStatement | undefined) => {
    const keys =
      statement?.Condition?.["ForAllValues:StringLike"]?.[
        "dynamodb:LeadingKeys"
      ];
    return keys === undefined ? undefined : [keys].flat();
  };
  const read = keysOf(Statement.find(({ Sid }) => Sid === "HotUpdaterRead"));
  const write = keysOf(Statement.find(({ Sid }) => Sid === "HotUpdaterWrite"));
  if (read !== undefined && write !== undefined) return { read, write };
  const legacy = keysOf(Statement.find(({ Sid }) => Sid === undefined));
  return legacy === undefined ? undefined : { read: legacy, write: legacy };
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

const DYNAMODB_POLICY_NAME = "HotUpdaterDynamoDBReadAccess";

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

  /** The access the role gives the deployment it has now, if any. */
  private async readDynamoDBAccess(
    iamClient: IAM,
    roleName: string,
  ): Promise<DynamoDBAccess | undefined> {
    try {
      const { PolicyDocument } = await iamClient.getRolePolicy({
        PolicyName: DYNAMODB_POLICY_NAME,
        RoleName: roleName,
      });
      return PolicyDocument === undefined
        ? undefined
        : dynamoDBAccessOf(decodeURIComponent(PolicyDocument));
    } catch (error) {
      if (error instanceof Error && error.name === "NoSuchEntityException") {
        return undefined;
      }
      throw error;
    }
  }

  private async ensureDynamoDBPolicy(
    iamClient: IAM,
    roleName: string,
    accountId: string,
    tableName: string,
    plugins: readonly PluginTables[],
  ): Promise<void> {
    // The edges run the deployment it replaces until the distribution
    // deploys, so its access stays until the next init.
    const previous = await this.readDynamoDBAccess(iamClient, roleName);
    await iamClient.putRolePolicy({
      PolicyDocument: JSON.stringify(
        buildDynamoDBPolicy(
          this.region,
          accountId,
          tableName,
          plugins,
          previous,
        ),
      ),
      PolicyName: DYNAMODB_POLICY_NAME,
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
