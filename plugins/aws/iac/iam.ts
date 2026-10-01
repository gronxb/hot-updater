import { createHash } from "node:crypto";

import { IAM } from "@aws-sdk/client-iam";
import { STS } from "@aws-sdk/client-sts";
import { InitError, p } from "@hot-updater/cli-tools";
import {
  coreTarget,
  type PluginTables,
  toolingTargetOf,
} from "@hot-updater/plugin-core";
import {
  aggregateBatchingModule,
  resolveSchema,
  SETTINGS_TABLE,
} from "@hot-updater/plugin-core/internal";

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
 * aggregate log and lease. Core's tables and the settings rows change only
 * through the CLI, and third-party plugins share the function's role.
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
  version?: string,
) => [
  {
    Sid: `${prefix}Read${version === undefined ? "" : `V${version}`}`,
    Action: READ_ACTIONS,
    Condition: {
      "ForAllValues:StringLike": { "dynamodb:LeadingKeys": [...access.read] },
    },
    Effect: "Allow",
    Resource: [tableArn],
  },
  {
    Sid: `${prefix}Write${version === undefined ? "" : `V${version}`}`,
    Action: WRITE_ACTIONS,
    Condition: {
      "ForAllValues:StringLike": { "dynamodb:LeadingKeys": [...access.write] },
    },
    Effect: "Allow",
    Resource: [tableArn],
  },
];

/** Whether `access` gives every partition `other` does. */
const covers = (access: DynamoDBAccess, other: DynamoDBAccess) =>
  other.read.every((key) => access.read.includes(key)) &&
  other.write.every((key) => access.write.includes(key));

const unionOf = (
  left: DynamoDBAccess,
  right: DynamoDBAccess,
): DynamoDBAccess => ({
  read: [...new Set([...left.read, ...right.read])],
  write: [...new Set([...left.write, ...right.write])],
});

/** The access the function needs to run `plugins`. */
const accessOf = (plugins: readonly PluginTables[]): DynamoDBAccess => ({
  read: dynamoDBLeadingKeys(plugins),
  write: dynamoDBWriteLeadingKeys(plugins),
});

/**
 * The function's DynamoDB access: `plugins`' partitions, and `previous`,
 * the access of the versions the edges may still run, while a deploy rolls
 * out. `version` records the function version the distribution was updated
 * to with this access, once init has done so.
 */
export const buildDynamoDBPolicy = (
  region: string,
  accountId: string,
  tableName: string,
  plugins: readonly PluginTables[] = packagePlugins,
  previous?: DynamoDBAccess,
  version?: string,
) => {
  const tableArn = `arn:aws:dynamodb:${region}:${accountId}:table/${tableName}`;
  const current = accessOf(plugins);
  return {
    Version: "2012-10-17",
    Statement: [
      ...statementsOf("HotUpdater", tableArn, current, version),
      ...(previous === undefined || covers(current, previous)
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

/** What the function's DynamoDB policy gives it, as init last wrote it. */
export interface DynamoDBPolicyState {
  /** The access of the version init deployed last, or was deploying. */
  readonly current: DynamoDBAccess;
  /**
   * The function version the distribution was updated to with `current`,
   * which init records once the update succeeds.
   */
  readonly version?: string;
  /** The access kept for the versions the edges may still run. */
  readonly previous?: DynamoDBAccess;
}

/**
 * The state of a policy document. A policy from before the read and write
 * split has one statement for both, which its deployment still needs.
 */
export const dynamoDBPolicyStateOf = (
  document: string,
): DynamoDBPolicyState | undefined => {
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
  const statementOf = (pattern: RegExp) =>
    Statement.find(({ Sid }) => Sid !== undefined && pattern.test(Sid));
  const read = statementOf(/^HotUpdaterRead(?:V\d+)?$/u);
  const write = statementOf(/^HotUpdaterWrite(?:V\d+)?$/u);
  const readKeys = keysOf(read);
  const writeKeys = keysOf(write);
  if (readKeys === undefined || writeKeys === undefined) {
    const legacy = keysOf(Statement.find(({ Sid }) => Sid === undefined));
    return legacy === undefined
      ? undefined
      : { current: { read: legacy, write: legacy } };
  }
  const readVersion = /V(\d+)$/u.exec(read!.Sid!)?.[1];
  const writeVersion = /V(\d+)$/u.exec(write!.Sid!)?.[1];
  const previousRead = keysOf(statementOf(/^HotUpdaterPreviousRead$/u));
  const previousWrite = keysOf(statementOf(/^HotUpdaterPreviousWrite$/u));
  return {
    current: { read: readKeys, write: writeKeys },
    ...(readVersion !== undefined && readVersion === writeVersion
      ? { version: readVersion }
      : {}),
    ...(previousRead === undefined || previousWrite === undefined
      ? {}
      : { previous: { read: previousRead, write: previousWrite } }),
  };
};

/**
 * Where the distribution stands with the function: whether its last update
 * finished deploying to the edges, and the function versions its behaviors
 * run.
 */
export interface EdgeDeployment {
  readonly deployed: boolean;
  readonly versions: readonly string[];
}

/**
 * The access an init keeps for the versions the edges may still run. Once
 * the distribution reports Deployed on the one version `state.current` was
 * recorded for, that is all it runs, so its access is enough. Until then,
 * the init keeps everything the policy gives, so an init that failed after
 * writing the policy, or two inits in one propagation window, never take
 * access from a version still serving.
 */
export const retainedDynamoDBAccess = (
  state: DynamoDBPolicyState | undefined,
  edge: EdgeDeployment | undefined,
): DynamoDBAccess | undefined => {
  if (state === undefined) return undefined;
  const settled =
    state.version !== undefined &&
    edge !== undefined &&
    edge.deployed &&
    edge.versions.length > 0 &&
    edge.versions.every((version) => version === state.version);
  return settled || state.previous === undefined
    ? state.current
    : unionOf(state.current, state.previous);
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

/** IAM's limit on a role's inline policies together, whitespace aside. */
export const ROLE_POLICY_SIZE_LIMIT = 10_240;

const policySizeOf = (documents: readonly object[]) =>
  documents.reduce<number>(
    (total, document) => total + JSON.stringify(document).length,
    0,
  );

/** The function's execution role, one per Lambda installation. */
const roleNameOf = (lambdaName: string) =>
  `hot-updater-edge-${createHash("sha256")
    .update(lambdaName)
    .digest("hex")
    .slice(0, 16)}`;

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

  /** The state of the role's DynamoDB policy, if it has one. */
  private async readDynamoDBPolicyState(
    iamClient: IAM,
    roleName: string,
  ): Promise<DynamoDBPolicyState | undefined> {
    try {
      const { PolicyDocument } = await iamClient.getRolePolicy({
        PolicyName: DYNAMODB_POLICY_NAME,
        RoleName: roleName,
      });
      return PolicyDocument === undefined
        ? undefined
        : dynamoDBPolicyStateOf(decodeURIComponent(PolicyDocument));
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
    document: object,
  ): Promise<void> {
    await iamClient.putRolePolicy({
      PolicyDocument: JSON.stringify(document),
      PolicyName: DYNAMODB_POLICY_NAME,
      RoleName: roleName,
    });
  }

  /**
   * Records that the distribution now runs `functionArn`'s version with the
   * access init wrote for `plugins`, so a later init can drop the access it
   * kept for the versions before, once the distribution deploys it. If
   * another init wrote the policy since, it records nothing, and the next
   * init keeps every access the policy gives.
   */
  async recordDeployedVersion(options: {
    readonly dynamodbTableName: string;
    readonly functionArn: string;
    readonly lambdaName: string;
    readonly plugins: readonly PluginTables[];
  }): Promise<void> {
    const iamClient = new IAM({
      region: this.region,
      credentials: this.credentials,
    });
    const roleName = roleNameOf(options.lambdaName);
    const state = await this.readDynamoDBPolicyState(iamClient, roleName);
    const current = accessOf(options.plugins);
    if (
      state === undefined ||
      !covers(state.current, current) ||
      !covers(current, state.current)
    ) {
      return;
    }
    const [, , , , accountId, , , version] = options.functionArn.split(":");
    if (accountId === undefined || version === undefined) return;
    await iamClient.putRolePolicy({
      PolicyDocument: JSON.stringify(
        buildDynamoDBPolicy(
          this.region,
          accountId,
          options.dynamodbTableName,
          options.plugins,
          state.previous,
          version,
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
    /** The distribution the function runs behind, if it exists yet. */
    readonly edge?: EdgeDeployment;
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
    const roleName = roleNameOf(options.lambdaName);

    // The function's DynamoDB access, and the access it keeps for the
    // versions the edges may still run, which the edges run until the
    // distribution deploys this one. IAM limits a role's inline policies
    // together, so they are checked before any is written.
    const previous = retainedDynamoDBAccess(
      await this.readDynamoDBPolicyState(iamClient, roleName),
      options.edge,
    );
    const dynamoDBPolicy = buildDynamoDBPolicy(
      this.region,
      accountId,
      options.dynamodbTableName,
      options.plugins,
      previous,
    );
    const fixedPolicies = [
      buildS3Policy(options.bucketName),
      buildSsmPolicy(this.region, accountId, options.ssmParameterName),
    ];
    const policySize = policySizeOf([...fixedPolicies, dynamoDBPolicy]);
    if (policySize > ROLE_POLICY_SIZE_LIMIT) {
      const pluginIds =
        options.plugins.map(({ id }) => id).join(", ") || "none";
      const withoutKept = policySizeOf([
        ...fixedPolicies,
        buildDynamoDBPolicy(
          this.region,
          accountId,
          options.dynamodbTableName,
          options.plugins,
        ),
      ]);
      throw new InitError(
        withoutKept <= ROLE_POLICY_SIZE_LIMIT
          ? `The managed AWS server's role would hold ${policySize} characters of IAM policy, over IAM's ${ROLE_POLICY_SIZE_LIMIT} for a role's inline policies, because it also keeps the access of the versions the distribution may still run while this deploy rolls out. Deploy the change in two inits: first a server definition without the plugins it drops, then, once the distribution reports that deploy as Deployed, one with the plugins it adds (plugins: ${pluginIds}).`
          : `The managed AWS server's role would hold ${policySize} characters of IAM policy for the tables of its plugins (${pluginIds}), over IAM's ${ROLE_POLICY_SIZE_LIMIT} for a role's inline policies. Remove plugins or their tables from the server definition, or host the server yourself.`,
      );
    }

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
        await this.ensureDynamoDBPolicy(iamClient, roleName, dynamoDBPolicy);
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

        await this.ensureDynamoDBPolicy(iamClient, roleName, dynamoDBPolicy);
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
