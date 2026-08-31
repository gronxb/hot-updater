import { DatabasePluginInputError } from "@hot-updater/plugin-core";
import { assertInsightsEventRow } from "@hot-updater/plugin-core/internal";
import { FieldPath, type Firestore } from "firebase-admin/firestore";

import { parseFirebaseBundleEventRow } from "./firebaseDatabaseParser";
import {
  type FirebaseDatabaseCollections,
  requireFirebaseDocumentKey,
} from "./firebaseDatabasePersistence";
import {
  FIREBASE_EVENT_INDEX_STATE,
  firebaseEventIndexFields,
} from "./firebaseEventIndex";

// DB tooling only. All old writers must be drained before the first step.
// New writers add keys atomically, including inserts behind this bookmark.
export const backfillFirebaseEventIndexStep = async (
  db: Firestore,
  collections: FirebaseDatabaseCollections,
  limit: number,
): Promise<{ state: "ready" | "building"; processed: number }> => {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
    throw new DatabasePluginInputError("invalid-query");
  }
  const reference = collections.settings.doc(FIREBASE_EVENT_INDEX_STATE);
  return db.runTransaction(
    async (transaction) => {
      const saved = await transaction.get(reference);
      const state = saved.data();
      if (
        state !== undefined &&
        (state.version !== 1 ||
          !["ready", "building"].includes(state.state) ||
          !Number.isSafeInteger(state.revision) ||
          state.revision < 1 ||
          (state.upperId !== null && typeof state.upperId !== "string") ||
          (state.afterId !== null && typeof state.afterId !== "string") ||
          (state.state === "building" &&
            (typeof state.upperId !== "string" || state.upperId.length === 0)))
      )
        throw new DatabasePluginInputError("invalid-data");
      if (state?.state === "ready") return { state: "ready", processed: 0 };
      if (state === undefined) {
        const upper = await transaction.get(
          collections.bundleEvents.orderBy("id", "desc").limit(1),
        );
        const upperId = upper.docs[0]?.id ?? null;
        if (upper.docs[0]) {
          const document = upper.docs[0];
          const row = requireFirebaseDocumentKey(
            "bundle_events",
            document.id,
            parseFirebaseBundleEventRow(document.data(), document.ref.path),
          );
          assertInsightsEventRow(row);
          firebaseEventIndexFields(row);
        }
        // Firestore cannot scan document keys backwards. The id field supplies
        // the upper bound; this same-snapshot key probe detects documents that
        // its index omitted (missing id or a mismatched key) beyond that bound.
        let tail = collections.bundleEvents.orderBy(
          FieldPath.documentId(),
          "asc",
        );
        if (upperId !== null) tail = tail.startAfter(upperId);
        if (!(await transaction.get(tail.limit(1))).empty) {
          throw new DatabasePluginInputError("invalid-data");
        }
        const next = upperId === null ? "ready" : "building";
        transaction.create(reference, {
          version: 1,
          state: next,
          revision: 1,
          upperId,
          afterId: null,
        });
        return { state: next, processed: 0 };
      }
      let query = collections.bundleEvents
        .orderBy(FieldPath.documentId(), "asc")
        .endAt(state.upperId);
      if (state.afterId !== null) query = query.startAfter(state.afterId);
      const documents = await transaction.get(query.limit(limit));
      for (const document of documents.docs) {
        const row = requireFirebaseDocumentKey(
          "bundle_events",
          document.id,
          parseFirebaseBundleEventRow(document.data(), document.ref.path),
        );
        assertInsightsEventRow(row);
        transaction.update(document.ref, firebaseEventIndexFields(row), {
          lastUpdateTime: document.updateTime,
        });
      }
      const afterId = documents.docs.at(-1)?.id ?? state.afterId;
      const next =
        documents.size < limit || afterId === state.upperId
          ? "ready"
          : "building";
      // Reading state inside this same transaction fences concurrent steps. Event
      // key updates and the checkpoint either commit together or do not advance.
      transaction.update(reference, {
        afterId,
        state: next,
        revision: state.revision + 1,
      });
      return { state: next, processed: documents.size };
    },
    { maxAttempts: 1 },
  );
};
