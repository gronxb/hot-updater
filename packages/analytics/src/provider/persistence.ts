import type { CreateBundleEventRequestBase } from "../domain.js";

export type BundleEventPersistenceRowBase = {
  readonly id: string;
  readonly install_id: string;
  readonly user_id: string | null;
  readonly username: string | null;
  readonly to_bundle_id: string;
  readonly platform: CreateBundleEventRequestBase["platform"];
  readonly app_version: string;
  readonly channel: string;
  readonly cohort: string;
  readonly fingerprint_hash: string | null;
  readonly sdk_version: string | null;
  readonly received_at_ms: number;
};

export type BundleEventPersistenceRow =
  | (BundleEventPersistenceRowBase & {
      readonly type: "UPDATE_APPLIED";
      readonly from_bundle_id: string;
      readonly update_strategy: "fingerprint" | "appVersion";
    })
  | (BundleEventPersistenceRowBase & {
      readonly type: "RECOVERED";
      readonly from_bundle_id: string;
      readonly update_strategy: "fingerprint" | "appVersion";
    })
  | (BundleEventPersistenceRowBase & {
      readonly type: "UNCHANGED";
      readonly from_bundle_id: null;
      readonly update_strategy: null;
    });

export type AnalyticsScanCursor = {
  readonly receivedAtMs: number;
  readonly id: string;
};

export type AnalyticsScanInput = {
  /** Rows must have `received_at_ms` strictly below this boundary. */
  readonly beforeReceivedAtMs: number;
  /** Exclusive cursor in ascending `(received_at_ms, id)` order. */
  readonly after?: AnalyticsScanCursor;
  readonly limit: number;
};

export interface AnalyticsPersistence {
  append(row: BundleEventPersistenceRow): Promise<void>;
  /** Returns at most `limit` rows in ascending `(received_at_ms, id)` order. */
  scan(
    input: AnalyticsScanInput,
  ): Promise<readonly BundleEventPersistenceRow[]>;
}
