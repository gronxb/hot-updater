import { beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({
  getClient: vi.fn(async () => ({})),
  options: [] as unknown[],
}));

vi.mock("google-auth-library", () => ({
  GoogleAuth: class {
    constructor(options: unknown) {
      auth.options.push(options);
    }
    getClient = auth.getClient;
  },
}));

import { resolveApplicationDefault } from "./googleCredential";

beforeEach(() => {
  auth.getClient.mockClear();
  auth.options.length = 0;
});

describe("resolveApplicationDefault", () => {
  it("resolves application default credentials for the app's project, without an OAuth exchange", async () => {
    const getAccessToken = vi.fn();

    await resolveApplicationDefault(
      { getAccessToken, googleAuth: {} } as never,
      "app",
    );

    expect(auth.getClient).toHaveBeenCalledOnce();
    expect(auth.options).toEqual([
      expect.objectContaining({ projectId: "app" }),
    ]);
    expect(getAccessToken).not.toHaveBeenCalled();
  });

  it("leaves a service account's credential alone", async () => {
    const getAccessToken = vi.fn();

    await resolveApplicationDefault({ getAccessToken } as never, "app");

    expect(auth.getClient).not.toHaveBeenCalled();
    expect(getAccessToken).not.toHaveBeenCalled();
  });
});
