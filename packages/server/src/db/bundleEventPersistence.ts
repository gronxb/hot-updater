import { createUUIDv7 } from "@hot-updater/plugin-core";
import type { BundleEventRow } from "@hot-updater/plugin-core";

import type { CreateBundleEventRequest } from "./types";

const getSdkVersion = (input: CreateBundleEventRequest): string | null => {
  const sdkVersion = Reflect.get(input, "sdkVersion");
  if (typeof sdkVersion === "string" || sdkVersion === null) {
    return sdkVersion ?? null;
  }
  return null;
};

export const createBundleEventRow = (
  input: CreateBundleEventRequest,
): BundleEventRow => {
  const base = {
    id: createUUIDv7(),
    install_id: input.installId,
    user_id: input.userId ?? null,
    username: input.username ?? null,
    to_bundle_id: input.toBundleId,
    platform: input.platform,
    app_version: input.appVersion,
    channel: input.channel,
    cohort: input.cohort,
    fingerprint_hash: input.fingerprintHash,
    sdk_version: getSdkVersion(input),
    received_at_ms: Date.now(),
  };
  switch (input.type) {
    case "UPDATE_APPLIED":
      return {
        ...base,
        type: "UPDATE_APPLIED",
        from_bundle_id: input.fromBundleId,
        update_strategy: input.updateStrategy,
      };
    case "RECOVERED":
      return {
        ...base,
        type: "RECOVERED",
        from_bundle_id: input.fromBundleId,
        update_strategy: input.updateStrategy,
      };
    case "UNCHANGED":
      return {
        ...base,
        type: "UNCHANGED",
        from_bundle_id: null,
        update_strategy: null,
      };
  }
};
