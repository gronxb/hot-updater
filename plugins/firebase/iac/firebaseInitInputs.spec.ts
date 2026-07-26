import { describe, expect, it } from "vitest";

import {
  assertFirebaseNonInteractiveInputs,
  getFirebaseCliEnv,
  resolveFirebaseInitInputs,
} from "./firebaseInitInputs";

describe("Firebase non-interactive init inputs", () => {
  it("reports project and region together", () => {
    const inputs = resolveFirebaseInitInputs({});

    expect(() => assertFirebaseNonInteractiveInputs(inputs, true)).toThrow(
      expect.objectContaining({
        missingInputs: [
          "HOT_UPDATER_FIREBASE_PROJECT_ID",
          "HOT_UPDATER_FIREBASE_REGION",
        ],
      }),
    );
  });

  it("does not treat the generated credential placeholder as authentication", () => {
    const inputs = resolveFirebaseInitInputs({
      GOOGLE_APPLICATION_CREDENTIALS: "your-credentials.json",
    });

    expect(inputs.applicationCredentials).toBeUndefined();
  });

  it("uses the credential file for Firebase and gcloud commands", () => {
    expect(getFirebaseCliEnv("/tmp/firebase-credentials.json")).toEqual({
      CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE: "/tmp/firebase-credentials.json",
      GOOGLE_APPLICATION_CREDENTIALS: "/tmp/firebase-credentials.json",
    });
  });
});
