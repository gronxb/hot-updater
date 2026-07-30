import path from "node:path";

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

  it("reports an invalid saved region as missing", () => {
    const inputs = resolveFirebaseInitInputs({
      HOT_UPDATER_FIREBASE_PROJECT_ID: "demo-project",
      HOT_UPDATER_FIREBASE_REGION: "us-central1; touch /tmp/injected",
    });

    expect(() => assertFirebaseNonInteractiveInputs(inputs, true)).toThrow(
      expect.objectContaining({
        missingInputs: ["HOT_UPDATER_FIREBASE_REGION"],
      }),
    );
  });

  it.each(["--", "--display-name", "Uppercase-project", "short"])(
    "reports an invalid saved project ID as missing: %s",
    (projectId) => {
      const inputs = resolveFirebaseInitInputs({
        HOT_UPDATER_FIREBASE_PROJECT_ID: projectId,
        HOT_UPDATER_FIREBASE_REGION: "us-central1",
      });

      expect(() => assertFirebaseNonInteractiveInputs(inputs, true)).toThrow(
        expect.objectContaining({
          missingInputs: ["HOT_UPDATER_FIREBASE_PROJECT_ID"],
        }),
      );
    },
  );

  it("uses the credential file for Firebase and gcloud commands", () => {
    expect(getFirebaseCliEnv("/tmp/firebase-credentials.json")).toEqual({
      CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE: "/tmp/firebase-credentials.json",
      GOOGLE_APPLICATION_CREDENTIALS: "/tmp/firebase-credentials.json",
    });
  });

  it("expands a home-relative credential path for Firebase and gcloud commands", () => {
    expect(
      getFirebaseCliEnv("~/firebase-credentials.json", {
        cwd: "/workspace/project",
        homeDir: "/Users/developer",
      }),
    ).toEqual({
      CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE:
        "/Users/developer/firebase-credentials.json",
      GOOGLE_APPLICATION_CREDENTIALS:
        "/Users/developer/firebase-credentials.json",
    });
  });

  it("expands a Windows home-relative credential path for Firebase and gcloud commands", () => {
    expect(
      getFirebaseCliEnv("~\\firebase-credentials.json", {
        cwd: "C:\\workspace\\project",
        homeDir: "C:\\Users\\developer",
        pathApi: path.win32,
      }),
    ).toEqual({
      CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE:
        "C:\\Users\\developer\\firebase-credentials.json",
      GOOGLE_APPLICATION_CREDENTIALS:
        "C:\\Users\\developer\\firebase-credentials.json",
    });
  });

  it("preserves a Windows absolute credential path for Firebase and gcloud commands", () => {
    expect(
      getFirebaseCliEnv("D:\\secrets\\firebase-credentials.json", {
        cwd: "C:\\workspace\\project",
        homeDir: "C:\\Users\\developer",
        pathApi: path.win32,
      }),
    ).toEqual({
      CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE:
        "D:\\secrets\\firebase-credentials.json",
      GOOGLE_APPLICATION_CREDENTIALS: "D:\\secrets\\firebase-credentials.json",
    });
  });
});
