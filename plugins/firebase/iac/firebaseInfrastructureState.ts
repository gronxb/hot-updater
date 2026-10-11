import fs from "fs/promises";

import {
  assertInfrastructureGenerationAtUrl,
  InitError,
  LegacyInfrastructureError,
} from "@hot-updater/cli-tools";
import {
  coreSettings,
  encodeKvKey,
  SETTINGS_TABLE,
} from "@hot-updater/plugin-core";
import {
  applicationDefault,
  cert,
  deleteApp,
  initializeApp,
} from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

import {
  FIREBASE_V1_COLLECTION,
  FIREBASE_V1_FUNCTION_NAME,
} from "../src/firebaseInfrastructureNames";
import { firestoreDocumentId } from "../src/firestoreStore";

/** The settings row of the storage engine's layout, which a setup checks first. */
const ENGINE_SETTING = "schema.engine";

export type FirebaseInfrastructureState = "fresh" | "incompatible" | "v1";

/**
 * v1 once the storage engine's schema settings are written; incompatible
 * when another engine version is recorded; otherwise fresh.
 */
export const resolveFirebaseInfrastructureState = ({
  engine,
}: {
  readonly engine: unknown;
}): FirebaseInfrastructureState => {
  if (engine === undefined) return "fresh";
  return engine === coreSettings[ENGINE_SETTING] ? "v1" : "incompatible";
};

/** The document holding `schema.engine` in the storage engine's collection. */
export const firebaseEngineSettingDocumentId = () =>
  firestoreDocumentId({
    pk: SETTINGS_TABLE.name,
    sk: encodeKvKey([ENGINE_SETTING]),
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
    const state = resolveFirebaseInfrastructureState({
      engine: setting.exists ? setting.get("row.value") : undefined,
    });
    if (state === "incompatible") {
      throw new InitError(
        `Firebase v1 infrastructure in project ${projectId} records an unsupported database version. Use a new Firebase project, or delete the ${FIREBASE_V1_COLLECTION} collection, then rerun init.`,
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
    try {
      await assertInfrastructureGenerationAtUrl({
        fetchImpl,
        provider: "Firebase",
        resource: `Function ${FIREBASE_V1_FUNCTION_NAME}`,
        versionUrl,
      });
    } catch (error) {
      if (!(error instanceof LegacyInfrastructureError)) throw error;
      throw new InitError(
        `Function ${FIREBASE_V1_FUNCTION_NAME}, which init deploys, already exists in this Firebase project and is incompatible: its /version does not report Hot Updater infrastructure generation 1. Delete the function or use another Firebase project, then rerun init. The existing function was not changed.`,
      );
    }
  }
};
