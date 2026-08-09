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

  it("grants only update queries and Analytics event access", async () => {
    // Given
    const manager = new IAMManager("ap-northeast-2", {
      accessKeyId: "test-access-key",
      secretAccessKey: "test-secret-key",
    });

    // When
    await manager.createOrSelectRole({
      dynamodbTableName: "hot-updater-metadata",
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
          "arn:aws:dynamodb:ap-northeast-2:123456789012:table/hot-updater-metadata/index/*",
        ],
      },
      {
        Action: ["dynamodb:Query", "dynamodb:PutItem"],
        Condition: {
          "ForAllValues:StringEquals": {
            "dynamodb:LeadingKeys": ["analytics#bundle_events"],
          },
        },
        Effect: "Allow",
        Resource: [
          "arn:aws:dynamodb:ap-northeast-2:123456789012:table/hot-updater-metadata",
        ],
      },
      {
        Action: ["dynamodb:GetItem"],
        Condition: {
          "ForAllValues:StringEquals": {
            "dynamodb:LeadingKeys": ["_hot-updater"],
          },
        },
        Effect: "Allow",
        Resource: [
          "arn:aws:dynamodb:ap-northeast-2:123456789012:table/hot-updater-metadata",
        ],
      },
    ]);
  });
});
