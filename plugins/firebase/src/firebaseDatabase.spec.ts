import { SETTINGS_TABLE } from "@hot-updater/plugin-core";
import { applicationDefault, deleteApp, getApps } from "firebase-admin/app";
import { afterEach, describe, expect, it, vi } from "vitest";

import { firebaseDatabase } from "./firebaseDatabase";

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(getApps().map((app) => deleteApp(app)));
});

describe("firebaseDatabase", () => {
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
