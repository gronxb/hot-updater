import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  attachRolePolicy: vi.fn(),
  getCallerIdentity: vi.fn(),
  getRole: vi.fn(),
  getRolePolicy: vi.fn(),
  listAttachedRolePolicies: vi.fn(),
  putRolePolicy: vi.fn(),
}));

vi.mock("@aws-sdk/client-iam", () => ({
  IAM: vi.fn(function IAM() {
    return {
      attachRolePolicy: mocks.attachRolePolicy,
      getRole: mocks.getRole,
      getRolePolicy: mocks.getRolePolicy,
      listAttachedRolePolicies: mocks.listAttachedRolePolicies,
      putRolePolicy: mocks.putRolePolicy,
    };
  }),
}));

/** The role's inline policies, as IAM keeps them between inits. */
const rolePolicies = new Map<string, string>();

vi.mock("@aws-sdk/client-sts", () => ({
  STS: vi.fn(function STS() {
    return { getCallerIdentity: mocks.getCallerIdentity };
  }),
}));

import { definePlugin, defineTable } from "@hot-updater/server/plugins";

import { plugins } from "../src/plugins";
import { dynamoDBLeadingKeys, IAMManager } from "./iam";

describe("IAMManager DynamoDB access", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCallerIdentity.mockResolvedValue({ Account: "123456789012" });
    mocks.getRole.mockResolvedValue({
      Role: { Arn: "arn:aws:iam::123456789012:role/hot-updater-edge-role" },
    });
    mocks.listAttachedRolePolicies.mockResolvedValue({
      AttachedPolicies: [
        {
          PolicyArn:
            "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole",
        },
        { PolicyArn: "arn:aws:iam::aws:policy/AmazonS3ReadOnlyAccess" },
      ],
    });
    rolePolicies.clear();
    mocks.putRolePolicy.mockImplementation(
      async ({ PolicyName, PolicyDocument }) => {
        rolePolicies.set(PolicyName, PolicyDocument);
        return {};
      },
    );
    // IAM hands a policy document back URL-encoded.
    mocks.getRolePolicy.mockImplementation(async ({ PolicyName }) => {
      const document = rolePolicies.get(PolicyName);
      if (document === undefined) {
        throw Object.assign(new Error("not found"), {
          name: "NoSuchEntityException",
        });
      }
      return { PolicyDocument: encodeURIComponent(document) };
    });
  });

  /** The DynamoDB statements of the role's policy, by Sid. */
  const dynamoDBStatements = () =>
    Object.fromEntries(
      (
        JSON.parse(rolePolicies.get("HotUpdaterDynamoDBReadAccess")!) as {
          Statement: {
            Sid: string;
            Action: string[];
            Condition: {
              "ForAllValues:StringLike": { "dynamodb:LeadingKeys": string[] };
            };
          }[];
        }
      ).Statement.map((statement) => [
        statement.Sid,
        {
          actions: statement.Action,
          keys: statement.Condition["ForAllValues:StringLike"][
            "dynamodb:LeadingKeys"
          ],
        },
      ]),
    );

  it("grants update reads and atomic CRUD for every official domain", async () => {
    // Given
    const manager = new IAMManager("ap-northeast-2", {
      accessKeyId: "test-access-key",
      secretAccessKey: "test-secret-key",
    });

    // When
    await manager.createOrSelectRole({
      bucketName: "hot-updater-storage",
      dynamodbTableName: "hot-updater-metadata",
      lambdaName: "hot-updater-edge",
      ssmParameterName: "/hot-updater/hot-updater-storage/keypair",
      plugins,
    });

    // Then
    const partitions = (names: readonly string[]) =>
      names.flatMap((name) => [name, `${name}#*`]);
    const core = [
      "bundles",
      "bundle_patches",
      "releases",
      "release_catalogs",
      "channels",
      "bundle_totals",
    ];
    const pluginTables = [
      "bundle_events",
      "bundle_event_heads",
      "insights_overview",
      "insights_sketches",
      "insights_overview_daily",
      "insights_sketches_daily",
      "insights_overview_lifetime",
      "insights_sketches_lifetime",
      "insights_distribution",
      "insights_latest_by_bundle",
      "insights_outcomes",
      "insights_failures",
      "api_keys",
    ];
    const aggregate = [
      ...[0, 1, 2, 3, 4, 5, 6, 7].map((shard) => `aggregate_log_${shard}`),
      "aggregate_lease",
    ];
    // Reads reach every table's rows and index items; writes only the
    // plugins' and the aggregate log, since core and the settings change
    // through the CLI. No secondary index to reach.
    expect(dynamoDBStatements()).toEqual({
      HotUpdaterRead: {
        actions: [
          "dynamodb:BatchGetItem",
          "dynamodb:ConditionCheckItem",
          "dynamodb:GetItem",
          "dynamodb:Query",
        ],
        keys: partitions([
          ...core,
          ...pluginTables,
          ...aggregate,
          "private_hot_updater_settings",
        ]),
      },
      HotUpdaterWrite: {
        actions: [
          "dynamodb:BatchWriteItem",
          "dynamodb:DeleteItem",
          "dynamodb:PutItem",
          "dynamodb:TransactWriteItems",
          "dynamodb:UpdateItem",
        ],
        keys: partitions([...pluginTables, ...aggregate]),
      },
    });
    const s3PolicyCall = mocks.putRolePolicy.mock.calls.find(
      ([input]) => input.PolicyName === "HotUpdaterS3ReadAccess",
    );
    expect(JSON.parse(s3PolicyCall?.[0].PolicyDocument ?? "{}")).toMatchObject({
      Statement: [
        { Resource: ["arn:aws:s3:::hot-updater-storage"] },
        { Resource: ["arn:aws:s3:::hot-updater-storage/*"] },
      ],
    });
    const ssmPolicyCall = mocks.putRolePolicy.mock.calls.find(
      ([input]) => input.PolicyName === "HotUpdaterSSMAccess",
    );
    expect(JSON.parse(ssmPolicyCall?.[0].PolicyDocument ?? "{}")).toMatchObject(
      {
        Statement: [
          {
            Resource:
              "arn:aws:ssm:ap-northeast-2:123456789012:parameter/hot-updater/hot-updater-storage/keypair",
          },
        ],
      },
    );
  });

  it("isolates execution roles by Lambda installation", async () => {
    // Given
    const manager = new IAMManager("ap-northeast-2", {
      accessKeyId: "test-access-key",
      secretAccessKey: "test-secret-key",
    });

    // When
    await manager.createOrSelectRole({
      bucketName: "first-bucket",
      dynamodbTableName: "first-table",
      lambdaName: "first-edge",
      ssmParameterName: "/hot-updater/first-bucket/keypair",
      plugins,
    });
    await manager.createOrSelectRole({
      bucketName: "second-bucket",
      dynamodbTableName: "second-table",
      lambdaName: "second-edge",
      ssmParameterName: "/hot-updater/second-bucket/keypair",
      plugins,
    });

    // Then
    const roleNames = mocks.getRole.mock.calls.map(([input]) => input.RoleName);
    expect(new Set(roleNames).size).toBe(2);
  });

  it("reaches the tables of the plugins the server definition lists, and no others", () => {
    const notes = definePlugin({
      id: "notes",
      schemaVersion: "1",
      schema: {
        notes: defineTable(
          { id: { type: "string", maxLength: 64 }, body: { type: "string" } },
          { key: ["id"] },
        ),
      },
      init: () => ({ api: {} }),
    });

    const keys = dynamoDBLeadingKeys([notes]);

    // A plugin's tables are named after it.
    expect(keys).toEqual(
      expect.arrayContaining(["notes_notes", "notes_notes#*"]),
    );
    expect(keys).toEqual(expect.arrayContaining(["bundles", "bundles#*"]));
    expect(keys).not.toContain("api_keys");
    expect(keys).not.toContain("bundle_events");
  });

  it("keeps the access of the deployment it replaces until the next init, while the edges still run it", async () => {
    const manager = new IAMManager("ap-northeast-2", {
      accessKeyId: "test-access-key",
      secretAccessKey: "test-secret-key",
    });
    const deploy = (serverPlugins: typeof plugins | readonly []) =>
      manager.createOrSelectRole({
        bucketName: "hot-updater-storage",
        dynamodbTableName: "hot-updater-metadata",
        lambdaName: "hot-updater-edge",
        ssmParameterName: "/hot-updater/hot-updater-storage/keypair",
        plugins: serverPlugins,
      });

    await deploy(plugins);
    const withApiKeys = dynamoDBStatements();
    // The definition drops insights() and apiKeys().
    await deploy([]);

    const rollingOut = dynamoDBStatements();
    expect(rollingOut["HotUpdaterRead"]?.keys).not.toContain("api_keys");
    expect(rollingOut["HotUpdaterPreviousRead"]).toEqual(
      withApiKeys["HotUpdaterRead"],
    );
    expect(rollingOut["HotUpdaterPreviousWrite"]).toEqual(
      withApiKeys["HotUpdaterWrite"],
    );

    await deploy([]);
    expect(Object.keys(dynamoDBStatements())).toEqual([
      "HotUpdaterRead",
      "HotUpdaterWrite",
    ]);
  });

  it("keeps a policy from before the split while the deployment it served rolls out", async () => {
    const legacyKeys = ["bundles", "bundles#*", "api_keys", "api_keys#*"];
    rolePolicies.set(
      "HotUpdaterDynamoDBReadAccess",
      JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          {
            Action: ["dynamodb:GetItem", "dynamodb:PutItem"],
            Condition: {
              "ForAllValues:StringLike": { "dynamodb:LeadingKeys": legacyKeys },
            },
            Effect: "Allow",
            Resource: ["arn:aws:dynamodb:ap-northeast-2:123456789012:table/t"],
          },
        ],
      }),
    );
    const manager = new IAMManager("ap-northeast-2", {
      accessKeyId: "test-access-key",
      secretAccessKey: "test-secret-key",
    });

    await manager.createOrSelectRole({
      bucketName: "hot-updater-storage",
      dynamodbTableName: "hot-updater-metadata",
      lambdaName: "hot-updater-edge",
      ssmParameterName: "/hot-updater/hot-updater-storage/keypair",
      plugins: [],
    });

    const statements = dynamoDBStatements();
    expect(statements["HotUpdaterPreviousRead"]?.keys).toEqual(legacyKeys);
    expect(statements["HotUpdaterPreviousWrite"]?.keys).toEqual(legacyKeys);
  });
});
