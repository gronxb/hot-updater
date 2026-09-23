import fs from "fs/promises";

import {
  assertInfrastructureGenerationAtUrl,
  InitError,
} from "@hot-updater/cli-tools";
import {
  ENGINE_SCHEMA_KEY,
  ENGINE_SCHEMA_VERSION,
  encodeKvKey,
  SETTINGS_TABLE,
} from "@hot-updater/server/database";
import {
  applicationDefault,
  cert,
  deleteApp,
  initializeApp,
} from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

import {
  FIREBASE_PRE_ENGINE_COLLECTIONS,
  FIREBASE_V1_COLLECTION,
  FIREBASE_V1_FUNCTION_NAME,
} from "../src/firebaseInfrastructureNames";
import { firestoreDocumentId } from "../src/firestoreStore";

export type FirebaseInfrastructureState = "fresh" | "incompatible" | "v1";

/**
 * v1 once the storage engine's schema settings are written; incompatible
 * when a 1.0 release candidate's collections hold data, or another engine
 * version is recorded; otherwise fresh.
 */
export const resolveFirebaseInfrastructureState = ({
  engine,
  preEngineData,
}: {
  readonly engine: unknown;
  readonly preEngineData: boolean;
}): FirebaseInfrastructureState => {
  if (preEngineData) return "incompatible";
  if (engine === undefined) return "fresh";
  return engine === ENGINE_SCHEMA_VERSION ? "v1" : "incompatible";
};

/** The document holding `schema.engine` in the storage engine's collection. */
export const firebaseEngineSettingDocumentId = () =>
  firestoreDocumentId({
    pk: SETTINGS_TABLE.name,
    sk: encodeKvKey([ENGINE_SCHEMA_KEY]),
  });

export const assertFirebaseInfrastructureCanInitialize = async ({
  applicationCredentials,
  projectId,
}: {
  readonly applicationCredentials?: string;
  readonly projectId: string;
}): Promise<void> => {
  const credential = applicationCredentials
    ? cert(JSON.parse(await fs.readFile(applicationCredentials, "utf8")))
    : applicationDefault();
  const app = initializeApp(
    { credential, projectId },
    `hot-updater-init-${projectId}-${Date.now()}`,
  );
  try {
    const db = getFirestore(app);
    const setting = await db
      .collection(FIREBASE_V1_COLLECTION)
      .doc(firebaseEngineSettingDocumentId())
      .get();
    const preEngine = await Promise.all(
      FIREBASE_PRE_ENGINE_COLLECTIONS.map((name) =>
        db.collection(name).limit(1).get(),
      ),
    );
    const state = resolveFirebaseInfrastructureState({
      engine: setting.exists ? setting.get("row.value") : undefined,
      preEngineData: preEngine.some((snapshot) => !snapshot.empty),
    });
    if (state === "incompatible") {
      throw new InitError(
        `Firebase v1 infrastructure in project ${projectId} holds data from a 1.0 release candidate or an unsupported database version. Use a new Firebase project, or delete the hot_updater_v1_* collections, then rerun init.`,
      );
    }
  } catch (error) {
    if (error instanceof InitError) throw error;
    const code =
      typeof error === "object" && error !== null
        ? Reflect.get(error, "code")
        : undefined;
    if (code === 5 || code === "not-found") return;
    throw error;
  } finally {
    await deleteApp(app);
  }
};

export const assertFirebaseFunctionCanInitialize = async ({
  fetchImpl,
  functions,
}: {
  readonly fetchImpl?: typeof fetch;
  readonly functions: readonly {
    readonly id: string;
    readonly uri?: string;
  }[];
}): Promise<void> => {
  const existingFunctions = functions.filter(
    ({ id }) => id === FIREBASE_V1_FUNCTION_NAME,
  );
  for (const existingFunction of existingFunctions) {
    if (!existingFunction.uri) {
      throw new InitError(
        `Could not verify the Firebase infrastructure generation at Function ${FIREBASE_V1_FUNCTION_NAME}: endpoint URL was not reported.`,
      );
    }
    const versionUrl = new URL(
      "version",
      `${existingFunction.uri.replace(/\/$/u, "")}/`,
    ).toString();
    await assertInfrastructureGenerationAtUrl({
      fetchImpl,
      provider: "Firebase",
      resource: `Function ${FIREBASE_V1_FUNCTION_NAME}`,
      versionUrl,
    });
  }
};
