import { execa } from "execa";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { resolveCloudflareInfrastructureApiToken } from "./cloudflareInfrastructureAuth";
import { getWranglerLoginAuthToken } from "./getWranglerLoginAuthToken";

vi.mock("execa", () => ({ execa: vi.fn() }));
vi.mock("./getWranglerLoginAuthToken", () => ({
  getWranglerLoginAuthToken: vi.fn(),
}));

const login = (oauthToken: string, expiresInMs: number) => ({
  oauth_token: oauthToken,
  expiration_time: new Date(Date.now() + expiresInMs).toISOString(),
  refresh_token: "refresh-token",
  scopes: [],
});

describe("resolveCloudflareInfrastructureApiToken", () => {
  beforeEach(() => {
    vi.mocked(execa).mockReset();
    vi.mocked(getWranglerLoginAuthToken).mockReset();
  });

  it("uses a Wrangler login that has not expired, without running Wrangler", async () => {
    vi.mocked(getWranglerLoginAuthToken).mockReturnValue(
      login("current", 60_000),
    );

    await expect(
      resolveCloudflareInfrastructureApiToken({
        cwd: "/project",
        nonInteractive: true,
      }),
    ).resolves.toBe("current");
    expect(execa).not.toHaveBeenCalled();
  });

  it("renews an expired Wrangler login with a Wrangler command, without a browser, before it gives up on a non-interactive run", async () => {
    vi.mocked(getWranglerLoginAuthToken)
      .mockReturnValueOnce(login("expired", -60_000))
      .mockReturnValue(login("renewed", 60_000));

    await expect(
      resolveCloudflareInfrastructureApiToken({
        cwd: "/project",
        nonInteractive: true,
      }),
    ).resolves.toBe("renewed");
    expect(execa).toHaveBeenCalledExactlyOnceWith(
      "npx",
      ["wrangler", "whoami"],
      expect.objectContaining({ cwd: "/project", stdio: "ignore" }),
    );
  });

  it("asks for a Wrangler login on a non-interactive run when the renewal fails", async () => {
    vi.mocked(getWranglerLoginAuthToken).mockReturnValue(
      login("expired", -60_000),
    );

    await expect(
      resolveCloudflareInfrastructureApiToken({
        cwd: "/project",
        nonInteractive: true,
      }),
    ).rejects.toThrow("Cloudflare Wrangler login is required.");
  });
});
