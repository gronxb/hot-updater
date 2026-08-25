import { beforeEach, describe, expect, it, vi } from "vitest";

const lambdaMocks = vi.hoisted(() => ({
  createFunction: vi.fn(),
  getFunctionConfiguration: vi.fn(),
  publishVersion: vi.fn(),
  updateFunctionCode: vi.fn(),
  updateFunctionConfiguration: vi.fn(),
}));

const fileMocks = vi.hoisted(() => ({
  readFile: vi.fn(),
  rm: vi.fn(),
  writeFile: vi.fn(),
}));
const transformEnvMock = vi.hoisted(() => vi.fn(() => "transformed-code"));

vi.mock("@aws-sdk/client-lambda", () => ({
  Lambda: vi.fn(function Lambda() {
    return lambdaMocks;
  }),
}));

vi.mock("fs/promises", () => ({
  default: fileMocks,
}));

vi.mock("@hot-updater/cli-tools", () => ({
  copyDirToTmp: vi.fn(async () => ({
    tmpDir: "/tmp/hot-updater-lambda",
    removeTmpDir: vi.fn(async () => undefined),
  })),
  createZip: vi.fn(async () => undefined),
  getCwd: vi.fn(() => "/tmp"),
  p: {
    log: { error: vi.fn(), info: vi.fn() },
    tasks: vi.fn(
      async (
        tasks: readonly {
          readonly task: (message: (value: string) => void) => Promise<string>;
        }[],
      ) => {
        for (const task of tasks) {
          await task.task(vi.fn());
        }
      },
    ),
  },
  transformEnv: transformEnvMock,
}));

import { LambdaEdgeDeployer } from "./lambdaEdge";

describe("LambdaEdgeDeployer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fileMocks.readFile.mockResolvedValue(Buffer.from("lambda"));
    fileMocks.rm.mockResolvedValue(undefined);
    fileMocks.writeFile.mockResolvedValue(undefined);
    lambdaMocks.createFunction.mockRejectedValue(
      Object.assign(new Error("exists"), {
        name: "ResourceConflictException",
      }),
    );
    lambdaMocks.updateFunctionCode.mockResolvedValue({});
    lambdaMocks.updateFunctionConfiguration.mockResolvedValue({});
    lambdaMocks.getFunctionConfiguration.mockResolvedValue({
      LastUpdateStatus: "Successful",
      State: "Active",
    });
    lambdaMocks.publishVersion.mockResolvedValue({
      FunctionArn:
        "arn:aws:lambda:us-east-1:123456789012:function:hot-updater-edge:7",
      Version: "7",
    });
  });

  it("publishes the reconciled code, role, memory, and timeout as one version", async () => {
    // Given
    const deployer = new LambdaEdgeDeployer({
      accessKeyId: "test-access-key",
      secretAccessKey: "test-secret-key",
    });

    // When
    const result = await deployer.deploy(
      "arn:aws:iam::123456789012:role/hot-updater-edge",
      "hot-updater-edge",
      {
        authorityId: "aws.test-authority",
        bucketName: "hot-updater-storage",
        dynamodbRegion: "ap-northeast-2",
        dynamodbTableName: "hot-updater-metadata",
        publicKeyId: "public-key-id",
        ssmParameterName: "/hot-updater/hot-updater-storage/keypair",
        ssmRegion: "ap-northeast-2",
      },
    );

    // Then
    expect(lambdaMocks.updateFunctionCode).toHaveBeenCalledWith({
      FunctionName: "hot-updater-edge",
      Publish: false,
      ZipFile: expect.any(Buffer),
    });
    expect(transformEnvMock).toHaveBeenCalledWith(
      "/tmp/hot-updater-lambda/index.cjs",
      expect.objectContaining({ AUTHORITY_ID: "aws.test-authority" }),
    );
    expect(lambdaMocks.updateFunctionConfiguration).toHaveBeenCalledWith({
      FunctionName: "hot-updater-edge",
      MemorySize: 256,
      Role: "arn:aws:iam::123456789012:role/hot-updater-edge",
      Timeout: 10,
    });
    expect(lambdaMocks.publishVersion).toHaveBeenCalledWith({
      FunctionName: "hot-updater-edge",
    });
    expect(
      lambdaMocks.updateFunctionCode.mock.invocationCallOrder[0],
    ).toBeLessThan(
      lambdaMocks.updateFunctionConfiguration.mock.invocationCallOrder[0] ?? 0,
    );
    expect(
      lambdaMocks.updateFunctionConfiguration.mock.invocationCallOrder[0],
    ).toBeLessThan(lambdaMocks.publishVersion.mock.invocationCallOrder[0] ?? 0);
    expect(result.functionArn).toBe(
      "arn:aws:lambda:us-east-1:123456789012:function:hot-updater-edge:7",
    );
  });

  it("creates the first published version with the same runtime limits", async () => {
    // Given
    lambdaMocks.createFunction.mockResolvedValue({
      FunctionArn:
        "arn:aws:lambda:us-east-1:123456789012:function:hot-updater-edge",
      Version: "1",
    });
    const deployer = new LambdaEdgeDeployer({
      accessKeyId: "test-access-key",
      secretAccessKey: "test-secret-key",
    });

    // When
    await deployer.deploy(
      "arn:aws:iam::123456789012:role/hot-updater-edge",
      "hot-updater-edge",
      {
        authorityId: "aws.test-authority",
        bucketName: "hot-updater-storage",
        dynamodbRegion: "ap-northeast-2",
        dynamodbTableName: "hot-updater-metadata",
        publicKeyId: "public-key-id",
        ssmParameterName: "/hot-updater/hot-updater-storage/keypair",
        ssmRegion: "ap-northeast-2",
      },
    );

    // Then
    expect(lambdaMocks.createFunction).toHaveBeenCalledWith(
      expect.objectContaining({
        MemorySize: 256,
        Publish: true,
        Role: "arn:aws:iam::123456789012:role/hot-updater-edge",
        Timeout: 10,
      }),
    );
    expect(lambdaMocks.updateFunctionCode).not.toHaveBeenCalled();
  });

  it("retries first-time creation while the new IAM role propagates", async () => {
    // Given
    vi.useFakeTimers();
    lambdaMocks.createFunction
      .mockRejectedValueOnce(
        Object.assign(
          new Error(
            "The role defined for the function cannot be assumed by Lambda.",
          ),
          { name: "InvalidParameterValueException" },
        ),
      )
      .mockResolvedValue({
        FunctionArn:
          "arn:aws:lambda:us-east-1:123456789012:function:hot-updater-edge",
        Version: "1",
      });
    const deployer = new LambdaEdgeDeployer({
      accessKeyId: "test-access-key",
      secretAccessKey: "test-secret-key",
    });

    // When
    const deployment = deployer.deploy(
      "arn:aws:iam::123456789012:role/hot-updater-edge",
      "hot-updater-edge",
      {
        authorityId: "aws.test-authority",
        bucketName: "hot-updater-storage",
        dynamodbRegion: "ap-northeast-2",
        dynamodbTableName: "hot-updater-metadata",
        publicKeyId: "public-key-id",
        ssmParameterName: "/hot-updater/hot-updater-storage/keypair",
        ssmRegion: "ap-northeast-2",
      },
    );
    await vi.runAllTimersAsync();

    // Then
    await expect(deployment).resolves.toEqual({
      lambdaName: "hot-updater-edge",
      functionArn:
        "arn:aws:lambda:us-east-1:123456789012:function:hot-updater-edge:1",
    });
    expect(lambdaMocks.createFunction).toHaveBeenCalledTimes(2);
    expect(lambdaMocks.updateFunctionCode).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});
