import { generateKeyPairSync } from "node:crypto";

import { SETTINGS_TABLE } from "@hot-updater/plugin-core";
import {
  applicationDefault,
  cert,
  deleteApp,
  getApps,
  initializeApp,
} from "firebase-admin/app";
import { afterEach, describe, expect, it, vi } from "vitest";

const resolved = vi.hoisted(() => vi.fn());

vi.mock("./googleCredential", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./googleCredential")>();
  resolved.mockImplementation(actual.resolveApplicationDefault);
  return { resolveApplicationDefault: resolved };
});

import { firebaseDatabase } from "./firebaseDatabase";

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(getApps().map((app) => deleteApp(app)));
});

describe("firebaseDatabase", () => {
  it("checks the credential of the app it reads through, not one an existing app ignores", async () => {
    // firebaseStorage() in the same config initialized the default app with
    // another credential, which Firestore then uses.
    const appCredential = cert({
      clientEmail: "storage@hot-updater-test.iam.gserviceaccount.com",
      privateKey: generateKeyPairSync("rsa", { modulusLength: 2048 })
        .privateKey.export({ format: "pem", type: "pkcs8" })
        .toString(),
      projectId: "hot-updater-test",
    });
    initializeApp({
      credential: appCredential,
      projectId: "hot-updater-test",
    });
    vi.stubEnv("GOOGLE_APPLICATION_CREDENTIALS", "your-credentials.json");
    const { adapter } = firebaseDatabase({
      credential: applicationDefault(),
      projectId: "hot-updater-test",
    });
    resolved.mockRejectedValueOnce(new Error("stop before Firestore"));

    await expect(
      adapter.get(SETTINGS_TABLE, [["schema.core"]]),
    ).rejects.toThrow("stop before Firestore");
    expect(resolved).toHaveBeenCalledWith(appCredential, "hot-updater-test");
  });

  it("fails a read with what is wrong when its credential cannot load, and leaves no unawaited rejection", async () => {
    // A 1.0.0 .env.hotupdater's placeholder, which the config loads.
    vi.stubEnv("GOOGLE_APPLICATION_CREDENTIALS", "your-credentials.json");
    const { adapter } = firebaseDatabase({
      credential: applicationDefault(),
      projectId: "hot-updater-test",
    });

    // The schema fence's read, which doctor's first database read is.
    await expect(
      adapter.get(SETTINGS_TABLE, [["schema.core"]]),
    ).rejects.toThrow(
      /^Could not load the Google credentials for Firestore: .*your-credentials\.json/u,
    );
    // Firestore's client rejects a second promise on its own; vitest fails
    // the run on one nobody handles.
    await new Promise((resolve) => setTimeout(resolve, 200));
  });
});
