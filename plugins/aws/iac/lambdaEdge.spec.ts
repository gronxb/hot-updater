import { beforeEach, describe, expect, it, vi } from "vitest";

const mockLambda = vi.hoisted(() => ({
  createFunction: vi.fn(),
  updateFunctionCode: vi.fn(),
  updateFunctionConfiguration: vi.fn(),
  publishVersion: vi.fn(),
  getFunctionConfiguration: vi.fn(),
}));

const mockPrompt = vi.hoisted(() => ({
  log: {
    info: vi.fn(),
    error: vi.fn(),
  },
  tasks: vi.fn(
    async (
      tasks: {
        title: string;
        task: (message: (s: string) => void) => unknown;
      }[],
    ) => {
      for (const task of tasks) {
        await task.task(() => {});
      }
    },
  ),
}));

vi.mock("@aws-sdk/client-lambda", () => ({
  Lambda: vi.fn(function Lambda() {
    return mockLambda;
  }),
}));

vi.mock("fs/promises", () => ({
  default: {
    writeFile: vi.fn(),
    readFile: vi.fn(async () => Buffer.from("zip")),
    rm: vi.fn(),
  },
}));

vi.mock("./lambdaAsset", () => ({
  resolveLambdaDir: () => "/node_modules/@hot-updater/aws/lambda",
}));

vi.mock("@hot-updater/cli-tools", () => ({
  p: mockPrompt,
  getCwd: () => "/cwd",
  copyDirToTmp: async () => ({ tmpDir: "/tmp/lambda", removeTmpDir: vi.fn() }),
  createZip: vi.fn(),
  transformEnv: () => "code",
}));

import { LambdaEdgeDeployer } from "./lambdaEdge";

const config = {
  bucketName: "bucket",
  publicKeyId: "key-id",
  ssmParameterName: "/param",
  ssmRegion: "us-east-1",
};

const deploy = () =>
  new LambdaEdgeDeployer({
    accessKeyId: "access-key",
    secretAccessKey: "secret-key",
  }).deploy("role-arn", "hot-updater-edge", config);

describe("LambdaEdgeDeployer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLambda.getFunctionConfiguration.mockResolvedValue({
      LastUpdateStatus: "Successful",
      State: "Active",
    });
  });

  it("creates the function with the Lambda@Edge memory size", async () => {
    mockLambda.createFunction.mockResolvedValue({
      FunctionArn: "arn:aws:lambda:us-east-1:1:function:hot-updater-edge",
      Version: "1",
    });

    const result = await deploy();

    expect(mockLambda.createFunction).toHaveBeenCalledWith(
      expect.objectContaining({ MemorySize: 256, Timeout: 10 }),
    );
    expect(result.functionArn).toBe(
      "arn:aws:lambda:us-east-1:1:function:hot-updater-edge:1",
    );
  });

  it("publishes a version only after the configuration is applied", async () => {
    const conflict = new Error("Function already exist");
    conflict.name = "ResourceConflictException";
    mockLambda.createFunction.mockRejectedValue(conflict);
    mockLambda.updateFunctionCode.mockResolvedValue({
      FunctionArn: "arn:aws:lambda:us-east-1:1:function:hot-updater-edge",
    });
    mockLambda.updateFunctionConfiguration.mockResolvedValue({});
    mockLambda.publishVersion.mockResolvedValue({
      FunctionArn: "arn:aws:lambda:us-east-1:1:function:hot-updater-edge:7",
      Version: "7",
    });

    const result = await deploy();

    // The code update must not publish: a published version is an immutable
    // snapshot and would capture the previous deploy's configuration.
    expect(mockLambda.updateFunctionCode).toHaveBeenCalledWith(
      expect.objectContaining({ Publish: false }),
    );
    expect(mockLambda.updateFunctionConfiguration).toHaveBeenCalledWith(
      expect.objectContaining({ MemorySize: 256, Timeout: 10 }),
    );
    expect(
      mockLambda.updateFunctionConfiguration.mock.invocationCallOrder[0],
    ).toBeLessThan(mockLambda.publishVersion.mock.invocationCallOrder[0]);
    expect(result.functionArn).toBe(
      "arn:aws:lambda:us-east-1:1:function:hot-updater-edge:7",
    );
  });

  it("fails the deploy when the configuration update fails", async () => {
    const conflict = new Error("Function already exist");
    conflict.name = "ResourceConflictException";
    mockLambda.createFunction.mockRejectedValue(conflict);
    mockLambda.updateFunctionCode.mockResolvedValue({});
    mockLambda.updateFunctionConfiguration.mockRejectedValue(
      new Error("InvalidParameterValueException"),
    );

    await expect(deploy()).rejects.toThrow("InvalidParameterValueException");
    expect(mockLambda.publishVersion).not.toHaveBeenCalled();
  });
});
