import fs from "fs/promises";

import { InitError, LegacyInfrastructureError } from "@hot-updater/cli-tools";
import {
  applicationDefault,
  cert,
  deleteApp,
  initializeApp,
} from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

export type FirebaseInfrastructureState = "fresh" | "v0" | "v1";

export const resolveFirebaseInfrastructureState = ({
  adapterVersion,
  hasData,
}: {
  readonly adapterVersion: unknown;
  readonly hasData: boolean;
}): FirebaseInfrastructureState => {
  if (adapterVersion === 4) return "v1";
  if (adapterVersion !== undefined || hasData) return "v0";
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
      .collection("private_hot_updater_settings")
      .doc("database_adapter_version")
      .get();
    const collections = await Promise.all(
      ["bundles", "bundle_patches", "channels", "release_catalogs"].map(
        (name) => db.collection(name).limit(1).get(),
      ),
    );
    const state = resolveFirebaseInfrastructureState({
      adapterVersion: version.exists ? version.data()?.version : undefined,
      hasData: collections.some((snapshot) => !snapshot.empty),
    });
    if (state === "v0") {
      throw new LegacyInfrastructureError("Firebase", `project ${projectId}`);
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
