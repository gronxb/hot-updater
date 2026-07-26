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

  it("reports all required Cloudflare inputs before prompting in non-interactive mode", async () => {
    // Given
    const options = {
      accountId: "account-id",
      bucketName: "bucket-name",
      nonInteractive: true,
    };

    // When
    const inputs = inputCloudflareInitSecrets(options);

    // Then
    await expect(inputs).rejects.toMatchObject({
      missingInputs: [
        "HOT_UPDATER_CLOUDFLARE_R2_ACCESS_KEY_ID",
        "HOT_UPDATER_CLOUDFLARE_R2_SECRET_ACCESS_KEY",
        "HOT_UPDATER_CLOUDFLARE_WORKER_NAME",
      ],
    });
    expect(mocks.group).not.toHaveBeenCalled();
  });

  it("treats the optional API token as skipped in non-interactive mode", async () => {
    // Given
    const options = {
      accountId: "account-id",
      bucketName: "bucket-name",
      accessKeyId: "access-key-id",
      secretAccessKey: "secret-access-key",
      workerName: "worker-name",
      nonInteractive: true,
    };

    // When
    const inputs = await inputCloudflareInitSecrets(options);

    // Then
    expect(inputs.apiToken).toBe("");
    expect(mocks.password).not.toHaveBeenCalled();
  });
});
