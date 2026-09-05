import fs from "fs/promises";

import {
  assertInfrastructureGenerationAtUrl,
  InitError,
} from "@hot-updater/cli-tools";
import {
  applicationDefault,
  cert,
  deleteApp,
  initializeApp,
} from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

import {
  FIREBASE_V1_COLLECTION_NAMES,
  FIREBASE_V1_FUNCTION_NAME,
} from "../src/firebaseInfrastructureNames";

export type FirebaseInfrastructureState = "fresh" | "incompatible" | "v1";

export const resolveFirebaseInfrastructureState = ({
  adapterVersion,
  hasData,
}: {
  readonly adapterVersion: unknown;
  readonly hasData: boolean;
}): FirebaseInfrastructureState => {
  if (adapterVersion === 4 || adapterVersion === 5) return "v1";
  if (adapterVersion !== undefined || hasData) return "incompatible";
  return "fresh";
};

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
    const version = await db
      .collection(FIREBASE_V1_COLLECTION_NAMES.settings)
      .doc("database_adapter_version")
      .get();
    const collections = await Promise.all(
      [
        FIREBASE_V1_COLLECTION_NAMES.bundles,
        FIREBASE_V1_COLLECTION_NAMES.bundlePatches,
        FIREBASE_V1_COLLECTION_NAMES.channels,
        FIREBASE_V1_COLLECTION_NAMES.releaseCatalogs,
      ].map((name) => db.collection(name).limit(1).get()),
    );
    const state = resolveFirebaseInfrastructureState({
      adapterVersion: version.exists ? version.data()?.version : undefined,
      hasData: collections.some((snapshot) => !snapshot.empty),
    });
    if (state === "incompatible") {
      throw new InitError(
        `Firebase v1 infrastructure in project ${projectId} is incomplete or uses an unsupported database version.`,
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
