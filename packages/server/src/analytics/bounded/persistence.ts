import { createUUIDv7 } from "@hot-updater/plugin-core";

import type { CreateBundleEventRequest } from "../domain.js";
import type { BundleEventPersistenceRow } from "../persistence.js";

export function createBundleEventRow(
  input: CreateBundleEventRequest,
): BundleEventPersistenceRow {
  const base = {
    id: createUUIDv7(),
    install_id: input.installId,
    user_id: input.userId ?? null,
    username: input.username ?? null,
    from_release_id: input.fromReleaseId ?? null,
    to_release_id: input.toReleaseId ?? null,
    to_bundle_id: input.toBundleId,
    platform: input.platform,
    app_version: input.appVersion,
    channel: input.channel,
    cohort: input.cohort,
    fingerprint_hash: input.fingerprintHash,
    sdk_version: input.sdkVersion ?? null,
    received_at_ms: Date.now(),
  };
  switch (input.type) {
    case "UPDATE_APPLIED":
    case "RECOVERED":
    case "RELEASE_ADOPTED":
      return {
        ...base,
        type: input.type,
        from_bundle_id: input.fromBundleId,
        update_strategy: input.updateStrategy,
      };
    case "UNCHANGED":
      return {
        ...base,
        type: input.type,
        from_bundle_id: null,
        update_strategy: null,
      };
  }
}
