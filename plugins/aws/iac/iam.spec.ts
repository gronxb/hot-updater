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

import { InitError } from "@hot-updater/cli-tools";
import { definePlugin, defineTable } from "@hot-updater/plugin-core";

import { plugins } from "../src/plugins";
import { dynamoDBLeadingKeys, type EdgeDeployment, IAMManager } from "./iam";

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

  /**
   * One init's role step for `serverPlugins`, while the distribution is at
   * `edge`, and, when its deploy succeeds, the version the distribution now
   * runs.
   */
  const initWith = async (
    manager: IAMManager,
    serverPlugins: typeof plugins | readonly [],
    edge: EdgeDeployment | undefined,
    deployed?: string,
  ) => {
    await manager.createOrSelectRole({
      bucketName: "hot-updater-storage",
      dynamodbTableName: "hot-updater-metadata",
      lambdaName: "hot-updater-edge",
      ssmParameterName: "/hot-updater/hot-updater-storage/keypair",
      plugins: serverPlugins,
      edge,
    });
    if (deployed !== undefined) {
      await manager.recordDeployedVersion({
        dynamodbTableName: "hot-updater-metadata",
        functionArn: `arn:aws:lambda:us-east-1:123456789012:function:hot-updater-edge:${deployed}`,
        lambdaName: "hot-updater-edge",
        plugins: serverPlugins,
      });
    }
  };
  const deployedOn = (version: string): EdgeDeployment => ({
    deployed: true,
    versions: [version],
  });
  const rollingOutTo = (version: string): EdgeDeployment => ({
    deployed: false,
    versions: [version],
  });

  it("keeps the access of the versions the edges may run until the distribution deploys the one it recorded", async () => {
    const manager = new IAMManager("ap-northeast-2", {
      accessKeyId: "test-access-key",
      secretAccessKey: "test-secret-key",
    });

    await initWith(manager, plugins, undefined, "1");
    const withApiKeys = dynamoDBStatements();
    // The deploy recorded the version it runs on.
    expect(Object.keys(withApiKeys)).toEqual([
      "HotUpdaterReadV1",
      "HotUpdaterWriteV1",
    ]);

    // The definition drops insights() and apiKeys().
    await initWith(manager, [], deployedOn("1"), "2");
    const rollingOut = dynamoDBStatements();
    expect(rollingOut["HotUpdaterReadV2"]?.keys).not.toContain("api_keys");
    expect(rollingOut["HotUpdaterPreviousRead"]).toEqual(
      withApiKeys["HotUpdaterReadV1"],
    );
    expect(rollingOut["HotUpdaterPreviousWrite"]).toEqual(
      withApiKeys["HotUpdaterWriteV1"],
    );

    // Still rolling out: version 1 may serve.
    await initWith(manager, [], rollingOutTo("2"), "2");
    expect(dynamoDBStatements()["HotUpdaterPreviousRead"]?.keys).toEqual(
      expect.arrayContaining(["api_keys", "api_keys#*"]),
    );

    // Deployed on version 2, whose access is all the edges need.
    await initWith(manager, [], deployedOn("2"), "2");
    expect(Object.keys(dynamoDBStatements())).toEqual([
      "HotUpdaterReadV2",
      "HotUpdaterWriteV2",
    ]);
  });

  it("keeps the running version's access through an init that failed after writing the policy, and its retry", async () => {
    const manager = new IAMManager("ap-northeast-2", {
      accessKeyId: "test-access-key",
      secretAccessKey: "test-secret-key",
    });
    await initWith(manager, plugins, undefined, "1");
    const withApiKeys = dynamoDBStatements();

    // The init that drops apiKeys() fails at the Lambda deploy or the
    // CloudFront update: version 1 keeps serving, and nothing is recorded.
    await initWith(manager, [], deployedOn("1"));
    expect(dynamoDBStatements()["HotUpdaterPreviousRead"]).toEqual(
      withApiKeys["HotUpdaterReadV1"],
    );

    // The retry reads its own access as the policy's current one, which no
    // deploy recorded, so version 1's stays.
    await initWith(manager, [], deployedOn("1"));
    const retried = dynamoDBStatements();
    expect(retried["HotUpdaterRead"]?.keys).not.toContain("api_keys");
    expect(retried["HotUpdaterPreviousRead"]?.keys).toEqual(
      expect.arrayContaining(withApiKeys["HotUpdaterReadV1"]!.keys),
    );
    expect(retried["HotUpdaterPreviousWrite"]?.keys).toEqual(
      expect.arrayContaining(withApiKeys["HotUpdaterWriteV1"]!.keys),
    );

    // The retry's deploy succeeds, and once the distribution deploys it,
    // the next init drops version 1's access.
    await initWith(manager, [], deployedOn("1"), "2");
    expect(dynamoDBStatements()["HotUpdaterPreviousRead"]?.keys).toContain(
      "api_keys",
    );
    await initWith(manager, [], deployedOn("2"));
    expect(Object.keys(dynamoDBStatements())).toEqual([
      "HotUpdaterRead",
      "HotUpdaterWrite",
    ]);
  });

  it("keeps every access while two inits share one propagation window", async () => {
    const manager = new IAMManager("ap-northeast-2", {
      accessKeyId: "test-access-key",
      secretAccessKey: "test-secret-key",
    });
    await initWith(manager, plugins, undefined, "1");
    const withApiKeys = dynamoDBStatements();
    await initWith(manager, [], deployedOn("1"), "2");

    // The next init starts while the edges still move from version 1 to 2.
    await initWith(manager, [], rollingOutTo("2"), "3");
    const statements = dynamoDBStatements();
    expect(statements["HotUpdaterPreviousRead"]?.keys).toEqual(
      expect.arrayContaining(withApiKeys["HotUpdaterReadV1"]!.keys),
    );
    // A distribution that runs another version than the recorded one, or
    // none, keeps it too.
    await initWith(manager, [], deployedOn("2"));
    expect(dynamoDBStatements()["HotUpdaterPreviousRead"]?.keys).toContain(
      "api_keys",
    );
  });

  it("records nothing when another init wrote the policy after this one", async () => {
    const manager = new IAMManager("ap-northeast-2", {
      accessKeyId: "test-access-key",
      secretAccessKey: "test-secret-key",
    });
    await initWith(manager, plugins, undefined, "1");
    await initWith(manager, [], deployedOn("1"));

    // This init deployed plugins, but the policy now holds the other's.
    await manager.recordDeployedVersion({
      dynamodbTableName: "hot-updater-metadata",
      functionArn:
        "arn:aws:lambda:us-east-1:123456789012:function:hot-updater-edge:2",
      lambdaName: "hot-updater-edge",
      plugins,
    });

    expect(Object.keys(dynamoDBStatements())).toEqual([
      "HotUpdaterRead",
      "HotUpdaterWrite",
      "HotUpdaterPreviousRead",
      "HotUpdaterPreviousWrite",
    ]);
  });

  /** A plugin with `count` tables whose names are long. */
  const pluginWithTables = (id: string, count: number) =>
    definePlugin({
      id,
      schemaVersion: "1",
      schema: Object.fromEntries(
        Array.from({ length: count }, (_, index) => [
          `table_with_a_rather_long_descriptive_name_${index}`,
          defineTable(
            { id: { type: "string", maxLength: 64 } },
            { key: ["id"] },
          ),
        ]),
      ),
      init: () => ({ api: {} }),
    });

  it("refuses plugins whose tables would take the role past IAM's policy limit, before writing any policy", async () => {
    const manager = new IAMManager("ap-northeast-2", {
      accessKeyId: "test-access-key",
      secretAccessKey: "test-secret-key",
    });

    const setup = manager.createOrSelectRole({
      bucketName: "hot-updater-storage",
      dynamodbTableName: "hot-updater-metadata",
      lambdaName: "hot-updater-edge",
      ssmParameterName: "/hot-updater/hot-updater-storage/keypair",
      plugins: [...plugins, pluginWithTables("catalogSync", 60)],
    });

    await expect(setup).rejects.toBeInstanceOf(InitError);
    await expect(setup).rejects.toThrow(
      /^The managed AWS server's role would hold \d+ characters of IAM policy for the tables of its plugins \(insights, apiKeys, catalogSync\), over IAM's 10240 for a role's inline policies\. Remove plugins or their tables from the server definition, or host the server yourself\.$/u,
    );
    expect(mocks.putRolePolicy).not.toHaveBeenCalled();
  });

  it("refuses a change whose rollout would take the role past IAM's policy limit, and deploys it in two inits", async () => {
    const manager = new IAMManager("ap-northeast-2", {
      accessKeyId: "test-access-key",
      secretAccessKey: "test-secret-key",
    });
    const before = [
      pluginWithTables("reports", 22),
    ] as unknown as typeof plugins;
    const after = [
      pluginWithTables("billing", 22),
    ] as unknown as typeof plugins;
    await initWith(manager, before, undefined, "1");
    mocks.putRolePolicy.mockClear();

    // Version 1 serves until the new one deploys, so its access stays
    // beside the new definition's, which together don't fit.
    for (const edge of [rollingOutTo("1"), deployedOn("1")]) {
      await expect(initWith(manager, after, edge)).rejects.toThrow(
        "because it also keeps the access of the versions the distribution may still run while this deploy rolls out. Deploy the change in two inits: first a server definition without the plugins it drops, then, once the distribution reports that deploy as Deployed, one with the plugins it adds (plugins: billing).",
      );
    }
    expect(mocks.putRolePolicy).not.toHaveBeenCalled();

    // First without the plugin it drops, then with the one it adds.
    await initWith(manager, [], deployedOn("1"), "2");
    await initWith(manager, after, deployedOn("2"), "3");
    // Version 2's access is within version 3's, so nothing else is kept.
    const statements = dynamoDBStatements();
    expect(Object.keys(statements)).toEqual([
      "HotUpdaterReadV3",
      "HotUpdaterWriteV3",
    ]);
    expect(statements["HotUpdaterReadV3"]?.keys).toContain(
      "billing_table_with_a_rather_long_descriptive_name_0",
    );
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
