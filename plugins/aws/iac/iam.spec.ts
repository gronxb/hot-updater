import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  attachRolePolicy: vi.fn(),
  getCallerIdentity: vi.fn(),
  getRole: vi.fn(),
  listAttachedRolePolicies: vi.fn(),
  putRolePolicy: vi.fn(),
}));

vi.mock("@aws-sdk/client-iam", () => ({
  IAM: vi.fn(function IAM() {
    return {
      attachRolePolicy: mocks.attachRolePolicy,
      getRole: mocks.getRole,
      listAttachedRolePolicies: mocks.listAttachedRolePolicies,
      putRolePolicy: mocks.putRolePolicy,
    };
  }),
}));

vi.mock("@aws-sdk/client-sts", () => ({
  STS: vi.fn(function STS() {
    return { getCallerIdentity: mocks.getCallerIdentity };
  }),
}));

import { IAMManager } from "./iam";

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
    mocks.putRolePolicy.mockResolvedValue({});
  });

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
    });

    // Then
    const policyCall = mocks.putRolePolicy.mock.calls.find(
      ([input]) => input.PolicyName === "HotUpdaterDynamoDBReadAccess",
    );
    expect(policyCall).toBeDefined();
    const policyDocument = policyCall?.[0].PolicyDocument;
    expect(typeof policyDocument).toBe("string");
    const policy = JSON.parse(policyDocument) as {
      Statement: readonly Record<string, unknown>[];
    };
    expect(policy.Statement).toEqual([
      {
        Action: ["dynamodb:Query"],
        Effect: "Allow",
        Resource: [
          "arn:aws:dynamodb:ap-northeast-2:123456789012:table/hot-updater-metadata/index/hot-updater-update-index",
        ],
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
          "ForAllValues:StringLike": {
            "dynamodb:LeadingKeys": [
              "_hot-updater",
              "bundles",
              "bundle_patches",
              "channels",
              "_hot-updater#channel-names",
              "bundle_events",
              "_hot-updater#insights-installations",
              "_hot-updater#insights-event-ids",
              "_hot-updater#insights-bundle#*",
              "_hot-updater#insights-user#*",
              "api_keys",
              "_hot-updater#api-key-hashes",
            ],
          },
        },
        Effect: "Allow",
        Resource: [
          "arn:aws:dynamodb:ap-northeast-2:123456789012:table/hot-updater-metadata",
        ],
      },
    ]);
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
    });
    await manager.createOrSelectRole({
      bucketName: "second-bucket",
      dynamodbTableName: "second-table",
      lambdaName: "second-edge",
      ssmParameterName: "/hot-updater/second-bucket/keypair",
    });

    // Then
    const roleNames = mocks.getRole.mock.calls.map(([input]) => input.RoleName);
    expect(new Set(roleNames).size).toBe(2);
  });
});
