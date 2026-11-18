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

import { generateKeyPairSync } from "node:crypto";

import { applicationDefault, cert } from "firebase-admin/app";

import { resolveApplicationDefault } from "./googleCredential";

beforeEach(() => {
  auth.getClient.mockClear();
  auth.options.length = 0;
});

describe("resolveApplicationDefault", () => {
  it("resolves application default credentials for the app's project, without an OAuth exchange", async () => {
    const credential = applicationDefault();
    const getAccessToken = vi.spyOn(credential, "getAccessToken");

    await resolveApplicationDefault(credential, "app");

    expect(auth.getClient).toHaveBeenCalledOnce();
    expect(auth.options).toEqual([
      expect.objectContaining({ projectId: "app" }),
    ]);
    expect(getAccessToken).not.toHaveBeenCalled();
  });

  it("leaves a service account's credential alone, also once firebase-admin used it", async () => {
    const credential = cert({
      clientEmail: "sa@app.iam.gserviceaccount.com",
      privateKey: generateKeyPairSync("rsa", { modulusLength: 2048 })
        .privateKey.export({ format: "pem", type: "pkcs8" })
        .toString(),
      projectId: "app",
    });
    // What firebase-admin sets on a credential another API used.
    Object.assign(credential, { googleAuth: { getClient: vi.fn() } });

    await resolveApplicationDefault(credential, "app");

    expect(auth.getClient).not.toHaveBeenCalled();
  });
});
