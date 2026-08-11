import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  attachRolePolicy: vi.fn(),
  deleteRolePolicy: vi.fn(),
  getCallerIdentity: vi.fn(),
  getRole: vi.fn(),
  listAttachedRolePolicies: vi.fn(),
  putRolePolicy: vi.fn(),
}));

vi.mock("@aws-sdk/client-iam", () => ({
  IAM: vi.fn(function IAM() {
    return {
      attachRolePolicy: mocks.attachRolePolicy,
      deleteRolePolicy: mocks.deleteRolePolicy,
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
    mocks.deleteRolePolicy.mockResolvedValue({});
  });

  it("grants only update reads and built-in runtime domain access", async () => {
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
        Action: ["dynamodb:BatchGetItem", "dynamodb:GetItem"],
        Condition: {
          "ForAllValues:StringEquals": {
            "dynamodb:LeadingKeys": [
              "bundles",
              "bundle_patches",
              "client_access_keys",
              "_hot-updater#client-access-key-hashes",
            ],
          },
        },
        Effect: "Allow",
        Resource: [
          "arn:aws:dynamodb:ap-northeast-2:123456789012:table/hot-updater-metadata",
        ],
      },
      {
        Action: ["dynamodb:PutItem", "dynamodb:Query"],
        Condition: {
          "ForAllValues:StringEquals": {
            "dynamodb:LeadingKeys": ["bundle_events"],
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

  it("removes stale DynamoDB access when an installation selects S3", async () => {
    // Given
    const manager = new IAMManager("ap-northeast-2", {
      accessKeyId: "test-access-key",
      secretAccessKey: "test-secret-key",
    });

    // When
    await manager.createOrSelectRole({
      bucketName: "hot-updater-storage",
      lambdaName: "hot-updater-edge",
      ssmParameterName: "/hot-updater/hot-updater-storage/keypair",
    });

    // Then
    expect(mocks.deleteRolePolicy).toHaveBeenCalledWith({
      PolicyName: "HotUpdaterDynamoDBReadAccess",
      RoleName: expect.stringMatching(/^hot-updater-edge-[a-f0-9]{16}$/),
    });
  });
});
