import {
  getApp,
  getApps,
  initializeApp,
  type AppOptions,
} from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

import { FIREBASE_V1_COLLECTION_NAMES } from "./firebaseInfrastructureNames";
import {
  assertFirebaseInsightsDatabaseNamespace,
  createFirebaseInsightsCollections,
  createFirebaseInsightsQueries,
} from "./firebaseInsights";
import {
  runFirebaseInsightsJobStep,
  type RunFirebaseInsightsJobInput,
} from "./firebaseInsightsJobs";
import {
  appendFirebaseInsightsEvent,
  prepareFirebaseInsightsStep,
  projectFirebaseInsightsStep,
  publishFirebaseInsightsProjection,
  repairFirebaseInsightsPoisonStep,
  type PrepareFirebaseInsightsInput,
  type ProjectFirebaseInsightsInput,
  type RepairFirebaseInsightsPoisonInput,
} from "./firebaseInsightsMaintenance";

/** Internal v2 Insights query and bounded maintenance surface. */
export const firebaseInsightsDatabase = (
  config: AppOptions & { readonly insightsDatabaseNamespace: string },
) => {
  const databaseNamespace = assertFirebaseInsightsDatabaseNamespace(
    config.insightsDatabaseNamespace,
  );
  const { insightsDatabaseNamespace: _, ...appOptions } = config;
  const app = getApps().length ? getApp() : initializeApp(appOptions);
  const db = getFirestore(app);
  const collections = createFirebaseInsightsCollections(db, databaseNamespace);
  const append = (row: Parameters<typeof appendFirebaseInsightsEvent>[2]) =>
    appendFirebaseInsightsEvent(db, collections, row);
  return {
    model: createFirebaseInsightsQueries(
      collections,
      databaseNamespace,
      append,
    ),
    prepareStep: (input: PrepareFirebaseInsightsInput) =>
      prepareFirebaseInsightsStep(
        db,
        db.collection(FIREBASE_V1_COLLECTION_NAMES.bundleEvents),
        collections,
        input,
      ),
    projectStep: (input: ProjectFirebaseInsightsInput) =>
      projectFirebaseInsightsStep(db, collections, input),
    repairPoisonStep: (input: RepairFirebaseInsightsPoisonInput) =>
      repairFirebaseInsightsPoisonStep(
        db,
        db.collection(FIREBASE_V1_COLLECTION_NAMES.bundleEvents),
        collections,
        input,
      ),
    publishProjection: (observedAtMs: number) =>
      publishFirebaseInsightsProjection(db, collections, observedAtMs),
    runJobStep: (input: RunFirebaseInsightsJobInput) =>
      runFirebaseInsightsJobStep(db, collections, input),
  };
};

export type {
  FirebaseInsightsSourceShard,
  PrepareFirebaseInsightsInput,
  PrepareFirebaseInsightsResult,
  ProjectFirebaseInsightsInput,
  ProjectFirebaseInsightsResult,
  RepairFirebaseInsightsPoisonInput,
  RepairFirebaseInsightsPoisonResult,
} from "./firebaseInsightsMaintenance";
export type {
  RunFirebaseInsightsJobInput,
  RunFirebaseInsightsJobResult,
} from "./firebaseInsightsJobs";
