import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  command: vi.fn(),
  execa: vi.fn(),
}));

vi.mock("execa", () => ({
  execa: mocks.execa,
}));

import { createWrangler } from "./createWrangler";

describe("createWrangler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.execa.mockReturnValue(mocks.command);
    mocks.command.mockResolvedValue({});
  });

  it("marks replay commands as CI so Wrangler skips nested prompts", async () => {
    const wrangler = createWrangler({
      accountId: "account-id",
      cloudflareApiToken: "api-token",
      cwd: "/tmp/cloudflare-init",
      nonInteractive: true,
      stdio: "inherit",
    });

    await wrangler("d1", "migrations", "apply", "hot-updater", "--remote");

    expect(mocks.execa).toHaveBeenCalledWith({
      cwd: "/tmp/cloudflare-init",
      env: {
        CI: "true",
        CLOUDFLARE_ACCOUNT_ID: "account-id",
        CLOUDFLARE_API_TOKEN: "api-token",
      },
      extendsEnv: true,
      shell: true,
      stdio: "inherit",
    });
    expect(mocks.command).toHaveBeenCalledWith("npx", [
      "wrangler",
      "d1",
      "migrations",
      "apply",
      "hot-updater",
      "--remote",
    ]);
  });
});
