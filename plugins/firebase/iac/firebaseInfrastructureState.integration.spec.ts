import { getApps, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { afterEach, describe, expect, it } from "vitest";

import { FIREBASE_V1_COLLECTION } from "../src/firebaseInfrastructureNames";
import {
  assertFirebaseInfrastructureCanInitialize,
  firebaseEngineSettingDocumentId,
} from "./firebaseInfrastructureState";

const PROJECT_ID = "firebase-infrastructure-test";
const DATABASE_ID = `infra-${process.pid}`;
const app =
  getApps().find((existing) => existing.name === PROJECT_ID) ??
  initializeApp({ projectId: PROJECT_ID }, PROJECT_ID);

/** Records an engine version init does not support in `databaseId`. */
const recordUnsupportedEngine = (databaseId: string) =>
  getFirestore(app, databaseId)
    .collection(FIREBASE_V1_COLLECTION)
    .doc(firebaseEngineSettingDocumentId())
    .set({ row: { value: "0" } });

afterEach(async () => {
  for (const databaseId of ["(default)", DATABASE_ID]) {
    await getFirestore(app, databaseId)
      .collection(FIREBASE_V1_COLLECTION)
      .doc(firebaseEngineSettingDocumentId())
      .delete();
  }
});

describe("assertFirebaseInfrastructureCanInitialize", () => {
  it("reads the engine setting from the database init sets up", async () => {
    await recordUnsupportedEngine(DATABASE_ID);

    await expect(
      assertFirebaseInfrastructureCanInitialize({
        databaseId: DATABASE_ID,
        projectId: PROJECT_ID,
      }),
    ).rejects.toThrow(
      `Firebase v1 infrastructure in project ${PROJECT_ID} (Firestore database ${DATABASE_ID}) records an unsupported database version.`,
    );
    await expect(
      assertFirebaseInfrastructureCanInitialize({
        databaseId: "(default)",
        projectId: PROJECT_ID,
      }),
    ).resolves.toBeUndefined();
  });

  it("ignores another database's engine setting", async () => {
    await recordUnsupportedEngine("(default)");

    await expect(
      assertFirebaseInfrastructureCanInitialize({
        databaseId: DATABASE_ID,
        projectId: PROJECT_ID,
      }),
    ).resolves.toBeUndefined();
  });
});
