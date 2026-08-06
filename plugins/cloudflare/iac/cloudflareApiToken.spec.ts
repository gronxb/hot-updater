import http from "node:http";

import { Cloudflare } from "cloudflare";
import { describe, expect, it, vi } from "vitest";

import { verifyCloudflareApiTokenIdentity } from "./cloudflareApiToken";

describe("verifyCloudflareApiTokenIdentity", () => {
  it("uses account verification for an account-owned token", async () => {
    // Given
    const verifyAccountToken = vi.fn().mockResolvedValue({ status: "active" });
    const verifyUserToken = vi.fn();

    // When
    const result = await verifyCloudflareApiTokenIdentity({
      accountId: "account-id",
      apiToken: "cfat_token",
      verifyAccountToken,
      verifyUserToken,
    });

    // Then
    expect(result.status).toBe("active");
    expect(verifyAccountToken).toHaveBeenCalledWith("account-id");
    expect(verifyUserToken).not.toHaveBeenCalled();
  });

  it("sends account-owned token verification to the account endpoint", async () => {
    // Given
    const requestPaths: string[] = [];
    const server = http.createServer((request, response) => {
      requestPaths.push(request.url ?? "");
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          errors: [],
          messages: [],
          result: { id: "token-id", status: "active" },
          success: true,
        }),
      );
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Failed to bind local Cloudflare API fixture");
    }
    const client = new Cloudflare({
      apiToken: "cfat_fake-token",
      baseURL: `http://127.0.0.1:${address.port}/client/v4`,
      maxRetries: 0,
    });

    try {
      // When
      await verifyCloudflareApiTokenIdentity({
        accountId: "account-id",
        apiToken: "cfat_fake-token",
        verifyAccountToken: (accountId) =>
          client.accounts.tokens.verify({ account_id: accountId }),
        verifyUserToken: () => client.user.tokens.verify(),
      });

      // Then
      expect(requestPaths).toEqual([
        "/client/v4/accounts/account-id/tokens/verify",
      ]);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("uses user verification for a user-owned token", async () => {
    // Given
    const verifyAccountToken = vi.fn();
    const verifyUserToken = vi.fn().mockResolvedValue({ status: "active" });

    // When
    const result = await verifyCloudflareApiTokenIdentity({
      accountId: "account-id",
      apiToken: "cfut_token",
      verifyAccountToken,
      verifyUserToken,
    });

    // Then
    expect(result.status).toBe("active");
    expect(verifyAccountToken).not.toHaveBeenCalled();
    expect(verifyUserToken).toHaveBeenCalledOnce();
  });

  it("falls back to user verification for a legacy user token", async () => {
    // Given
    const verifyAccountToken = vi
      .fn()
      .mockRejectedValue(new Error("Authentication error [code: 10000]"));
    const verifyUserToken = vi.fn().mockResolvedValue({ status: "active" });

    // When
    const result = await verifyCloudflareApiTokenIdentity({
      accountId: "account-id",
      apiToken: "legacy-token",
      verifyAccountToken,
      verifyUserToken,
    });

    // Then
    expect(result.status).toBe("active");
    expect(verifyAccountToken).toHaveBeenCalledWith("account-id");
    expect(verifyUserToken).toHaveBeenCalledOnce();
  });

  it("preserves non-authentication failures for a legacy token", async () => {
    // Given
    const failure = new Error("Cloudflare API unavailable");
    const verifyAccountToken = vi.fn().mockRejectedValue(failure);
    const verifyUserToken = vi.fn();

    // When
    const verification = verifyCloudflareApiTokenIdentity({
      accountId: "account-id",
      apiToken: "legacy-token",
      verifyAccountToken,
      verifyUserToken,
    });

    // Then
    await expect(verification).rejects.toBe(failure);
    expect(verifyUserToken).not.toHaveBeenCalled();
  });
});
