import { describe, expect, it, vi } from "vitest";

import { toSdkCredentials } from "./lazyCredentials";

describe("toSdkCredentials", () => {
  it("passes the SDK's own credentials through", () => {
    const keys = { accessKeyId: "id", secretAccessKey: "secret" };
    const provider = async () => keys;

    expect(toSdkCredentials(undefined)).toBeUndefined();
    expect(toSdkCredentials(keys)).toBe(keys);
    expect(toSdkCredentials(provider)).toBe(provider);
  });

  it("makes access keys with lazy fields a provider, which reads nothing until called", async () => {
    const secretAccessKey = vi.fn(async () => "lazy-secret");
    const sessionToken = vi.fn(() => "lazy-session");

    const provider = toSdkCredentials({
      accessKeyId: "plain-id",
      secretAccessKey,
      sessionToken,
    });
    expect(provider).toBeTypeOf("function");
    expect(secretAccessKey).not.toHaveBeenCalled();

    await expect((provider as () => Promise<unknown>)()).resolves.toEqual({
      accessKeyId: "plain-id",
      secretAccessKey: "lazy-secret",
      sessionToken: "lazy-session",
    });
  });
});
