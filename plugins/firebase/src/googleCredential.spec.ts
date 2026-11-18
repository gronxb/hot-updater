import { describe, expect, it, vi } from "vitest";

import { resolveApplicationDefault } from "./googleCredential";

describe("resolveApplicationDefault", () => {
  it("resolves application default credentials without an OAuth exchange, and leaves a service account's alone", async () => {
    const getClient = vi.fn(async () => ({}));
    const getAccessToken = vi.fn();

    await resolveApplicationDefault({
      getAccessToken,
      googleAuth: { getClient },
    } as never);
    await resolveApplicationDefault({ getAccessToken } as never);

    expect(getClient).toHaveBeenCalledOnce();
    expect(getAccessToken).not.toHaveBeenCalled();
  });
});
