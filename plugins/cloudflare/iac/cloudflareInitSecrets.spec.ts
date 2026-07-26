import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  group: vi.fn(),
  password: vi.fn(),
  text: vi.fn(),
}));

vi.mock("@hot-updater/cli-tools", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@hot-updater/cli-tools")>();
  return {
    ...actual,
    p: {
      ...actual.p,
      group: mocks.group,
      password: mocks.password,
      text: mocks.text,
    },
  };
});

import { inputCloudflareInitSecrets } from "./cloudflareInitSecrets";

describe("inputCloudflareInitSecrets", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.group.mockImplementation(
      async (prompts: Record<string, () => Promise<string>>) => ({
        apiToken: await prompts.apiToken?.(),
        accessKeyId: await prompts.accessKeyId?.(),
        secretAccessKey: await prompts.secretAccessKey?.(),
        workerName: await prompts.workerName?.(),
      }),
    );
  });

  it("reuses an intentionally empty API token without prompting", async () => {
    // Given
    const options = {
      accountId: "account-id",
      bucketName: "bucket-name",
      apiToken: "",
      accessKeyId: "access-key-id",
      secretAccessKey: "secret-access-key",
      workerName: "worker-name",
    };

    // When
    const inputs = await inputCloudflareInitSecrets(options);

    // Then
    expect(inputs.apiToken).toBe("");
    expect(mocks.password).not.toHaveBeenCalled();
  });
});
