import { parseBundleEventPersistenceRow } from "@hot-updater/analytics/provider";
import type { BundleEventPersistenceRow } from "@hot-updater/analytics/provider";

export class FirebaseAnalyticsDocumentKeyError extends Error {
  readonly name = "FirebaseAnalyticsDocumentKeyError";

  constructor(
    readonly documentId: string,
    readonly rowId: string,
  ) {
    super("bundle_events.id.document-key");
  }
}

export const parseFirebaseAnalyticsDocument = (
  documentId: string,
  data: unknown,
): BundleEventPersistenceRow => {
  const row = parseBundleEventPersistenceRow(data);
  if (row.id !== documentId) {
    throw new FirebaseAnalyticsDocumentKeyError(documentId, row.id);
  }
  return row;
};
