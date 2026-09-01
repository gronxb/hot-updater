import {
  type InsightsInstallationPageInput,
  type InsightsPageEventsInput,
  type InsightsReportPageInput,
} from "@hot-updater/plugin-core";
import type { RequiredInsightsModel } from "@hot-updater/plugin-core/internal";
import {
  type RequiredInsightsModelConformanceHarness,
  registerRequiredInsightsModelTests,
} from "@hot-updater/test-utils";
import { deleteApp, initializeApp, type App } from "firebase-admin/app";
import { getFirestore, Query, type Firestore } from "firebase-admin/firestore";
import { afterAll, afterEach, beforeEach, describe, vi } from "vitest";

import {
  FIREBASE_INSIGHTS_INDEX_REVISION,
  FIREBASE_INSIGHTS_LAYOUT_VERSION,
  FIREBASE_INSIGHTS_SOURCE_SHARDS,
  firebaseEventDocumentId,
  firebaseEventScopeKey,
} from "./firebaseEventIndex";
import {
  type FirebaseInsightsCollections,
  createFirebaseInsightsCollections,
  createFirebaseInsightsQueries,
} from "./firebaseInsights";
import { runFirebaseInsightsJobStep } from "./firebaseInsightsJobs";
import { appendFirebaseInsightsEvent } from "./firebaseInsightsMaintenance";

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  throw new Error("Firebase integration tests require the Firestore emulator.");
}

const apps: App[] = [];
let harnessId = 0;
let currentTimeMs = 1;

type CandidateMeter = { last: number };

const measureCandidates = async <TResult>(
  meter: CandidateMeter,
  operation: () => Promise<TResult>,
): Promise<TResult> => {
  const reads = vi.spyOn(Query.prototype, "get");
  try {
    const result = await operation();
    const snapshots = await Promise.all(
      reads.mock.results.flatMap((call) =>
        call.type === "return" ? [call.value] : [],
      ),
    );
    if (snapshots.length > 0) {
      meter.last = snapshots.reduce(
        (total, snapshot) => total + snapshot.size,
        0,
      );
    }
    return result;
  } finally {
    reads.mockRestore();
  }
};

const eventBudget = (_input: InsightsPageEventsInput): number => 224;
const installationBudget = (_input: InsightsInstallationPageInput): number =>
  4_096;
const reportBudget = (_input: InsightsReportPageInput): number => 101;

const createHarness =
  async (): Promise<RequiredInsightsModelConformanceHarness> => {
    const projectId = `firebase-insights-conformance-${harnessId++}`;
    const app = initializeApp({ projectId }, projectId);
    const otherProjectId = `${projectId}-other`;
    const otherApp = initializeApp(
      { projectId: otherProjectId },
      otherProjectId,
    );
    apps.push(app, otherApp);
    const firestore = getFirestore(app);
    const otherFirestore = getFirestore(otherApp);
    const collections = createFirebaseInsightsCollections(firestore);
    const otherCollections = createFirebaseInsightsCollections(otherFirestore);
    const sourceVector = [
      ...Array.from(
        { length: FIREBASE_INSIGHTS_SOURCE_SHARDS },
        (_, shard) =>
          [`live_${shard.toString(16).padStart(2, "0")}`, 0] as const,
      ),
      ["legacy", 0] as const,
    ];
    await Promise.all(
      [collections, otherCollections].flatMap((namespaceCollections) => [
        namespaceCollections.control.doc("layout").set({
          version: FIREBASE_INSIGHTS_LAYOUT_VERSION,
          state: "ready",
          indexRevision: FIREBASE_INSIGHTS_INDEX_REVISION,
        }),
        namespaceCollections.control.doc("projection").set({
          version: FIREBASE_INSIGHTS_LAYOUT_VERSION,
          state: "ready",
          generation: firebaseEventScopeKey(JSON.stringify(sourceVector)),
          observedAtMs: currentTimeMs,
        }),
        ...sourceVector.flatMap(([sourceId]) => {
          const shard =
            sourceId === "legacy"
              ? "legacy"
              : Number.parseInt(sourceId.slice("live_".length), 16);
          return [
            namespaceCollections.sourceClocks.doc(sourceId).set({
              version: FIREBASE_INSIGHTS_LAYOUT_VERSION,
              shard,
              sequence: 0,
              observedAtMs: 0,
            }),
            namespaceCollections.control
              .doc(`projection_checkpoint_${sourceId}`)
              .set({
                version: FIREBASE_INSIGHTS_LAYOUT_VERSION,
                shard,
                sequence: 0,
              }),
          ];
        }),
      ]),
    );
    const completed = new Set<string>();
    let pendingMutation = Promise.resolve();

    const facade = (): RequiredInsightsModelConformanceHarness => {
      const primaryMeter: CandidateMeter = { last: 0 };
      const otherMeter: CandidateMeter = { last: 0 };
      const createModel = (
        namespace: string,
        meter: CandidateMeter,
        namespaceFirestore: Firestore,
        namespaceCollections: FirebaseInsightsCollections,
      ): RequiredInsightsModel => {
        const base = createFirebaseInsightsQueries(
          namespaceCollections,
          namespace,
          (row) =>
            appendFirebaseInsightsEvent(
              namespaceFirestore,
              namespaceCollections,
              row,
            ),
        );
        return {
          ...base,
          append: async (row) => {
            await pendingMutation;
            return base.append(row);
          },
          pageEvents: (input) =>
            measureCandidates(meter, async () => {
              await pendingMutation;
              return base.pageEvents(input);
            }),
          pageInstallations: ((input: InsightsInstallationPageInput) =>
            measureCandidates(meter, async () => {
              await pendingMutation;
              return base.pageInstallations(input);
            })) as RequiredInsightsModel["pageInstallations"],
          getReport: async (input) => {
            await pendingMutation;
            return base.getReport(input);
          },
          pageReport: (input) =>
            measureCandidates(meter, async () => {
              await pendingMutation;
              return base.pageReport(input);
            }),
        };
      };
      const model = createModel(
        `${projectId}/primary`,
        primaryMeter,
        firestore,
        collections,
      );
      const otherNamespaceModel = createModel(
        `${projectId}/other`,
        otherMeter,
        otherFirestore,
        otherCollections,
      );
      const runJobStep = async (
        namespaceFirestore: Firestore,
        namespaceCollections: FirebaseInsightsCollections,
        jobId: string,
        input: { readonly maxItems: number; readonly maxRequests: number },
      ) => {
        if (
          !Number.isSafeInteger(input.maxItems) ||
          input.maxItems < 1 ||
          input.maxItems > 4_096 ||
          !Number.isSafeInteger(input.maxRequests) ||
          input.maxRequests < 1 ||
          input.maxRequests > 4_096
        ) {
          throw new Error("invalid-maintenance-budget");
        }
        const result = await runFirebaseInsightsJobStep(
          namespaceFirestore,
          namespaceCollections,
          {
            jobId,
            maxItems: input.maxItems,
            maxRequests: input.maxRequests,
            nowMs: currentTimeMs,
          },
        );
        const usage = result.usage;
        if (result.state === "ready") {
          completed.add(jobId);
          return {
            state: "complete" as const,
            jobId,
            publicationId: jobId,
            usage,
          };
        }
        if (result.state === "failed") {
          return { state: "failed" as const, jobId, usage };
        }
        return result.processed === 0
          ? { state: "idle" as const, jobId, usage }
          : { state: "running" as const, jobId, usage };
      };
      return {
        model,
        otherNamespaceModel,
        runJobStep: (jobId, input) =>
          runJobStep(firestore, collections, jobId, input),
        runOtherNamespaceJobStep: (jobId, input) =>
          runJobStep(otherFirestore, otherCollections, jobId, input),
        reopen: facade,
        async insertMigrationPoisonRow() {
          const id = "00000000-0000-7000-8000-0000000000ff";
          const clock = collections.sourceClocks.doc("live_00");
          await firestore.runTransaction(async (transaction) => {
            const saved = await transaction.get(clock);
            const sequence = (saved.data()?.sequence ?? 0) + 1;
            transaction.set(clock, {
              version: FIREBASE_INSIGHTS_LAYOUT_VERSION,
              shard: 0,
              sequence,
              observedAtMs: currentTimeMs,
            });
            transaction.create(
              collections.events.doc(firebaseEventDocumentId(id)),
              {
                id,
                _insights_source_shard: 0,
                _insights_source_seq: sequence,
              },
            );
          });
        },
        setCurrentTimeMs(nowMs) {
          currentTimeMs = nowMs;
        },
        expirePublication(publicationId) {
          pendingMutation = pendingMutation.then(async () => {
            await collections.publications.doc(publicationId).delete();
          });
        },
        publicationStateForJob: (jobId) =>
          completed.has(jobId) ? "complete" : "absent",
        getLastStorageReadCount: (namespace = "primary") =>
          namespace === "primary" ? primaryMeter.last : otherMeter.last,
        getPageEventsCandidateReadBudget: eventBudget,
        getPageInstallationsCandidateReadBudget: installationBudget,
        getPageReportCandidateReadBudget: reportBudget,
      };
    };
    return facade();
  };

beforeEach(() => {
  currentTimeMs = 1;
  vi.spyOn(Date, "now").mockImplementation(() => currentTimeMs);
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await Promise.all(apps.splice(0).map((app) => deleteApp(app)));
});

describe("Firestore native Insights conformance", () => {
  registerRequiredInsightsModelTests(createHarness);
});
