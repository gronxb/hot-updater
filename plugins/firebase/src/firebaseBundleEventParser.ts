import type { DatabaseRow } from "@hot-updater/plugin-core";

import {
  hasFirebaseProperty,
  nullableString,
  number,
  platform,
  property,
  record,
  string,
  FirebaseDatabaseDataError,
} from "./firebaseDatabaseParserShared";

type BundleEventPersistenceRow = DatabaseRow<"bundle_events">;

export const parseFirebaseBundleEventRow = (
  value: unknown,
  source: string,
): BundleEventPersistenceRow => {
  const input = record(value, source);
  const type = string(property(input, "type"), source);
  if (
    !hasFirebaseProperty(input, "from_bundle_id") ||
    !hasFirebaseProperty(input, "update_strategy")
  ) {
    throw new FirebaseDatabaseDataError(source);
  }
  const fromBundleId = nullableString(
    property(input, "from_bundle_id"),
    source,
  );
  const updateStrategy = nullableString(
    property(input, "update_strategy"),
    source,
  );
  const common = {
    id: string(property(input, "id"), source),
    install_id: string(property(input, "install_id"), source),
    user_id: nullableString(property(input, "user_id"), source),
    username: nullableString(property(input, "username"), source),
    to_bundle_id: string(property(input, "to_bundle_id"), source),
    platform: platform(property(input, "platform"), source),
    app_version: string(property(input, "app_version"), source),
    channel: string(property(input, "channel"), source),
    cohort: string(property(input, "cohort"), source),
    fingerprint_hash: nullableString(
      property(input, "fingerprint_hash"),
      source,
    ),
    sdk_version: nullableString(property(input, "sdk_version"), source),
    received_at_ms: number(property(input, "received_at_ms"), source),
  };

  switch (type) {
    case "UNCHANGED":
      if (fromBundleId !== null || updateStrategy !== null) {
        throw new FirebaseDatabaseDataError(source);
      }
      return {
        ...common,
        type: "UNCHANGED",
        from_bundle_id: null,
        update_strategy: null,
      };
    case "UPDATE_APPLIED":
      if (
        fromBundleId === null ||
        (updateStrategy !== "fingerprint" && updateStrategy !== "appVersion")
      ) {
        throw new FirebaseDatabaseDataError(source);
      }
      return {
        ...common,
        type: "UPDATE_APPLIED",
        from_bundle_id: fromBundleId,
        update_strategy: updateStrategy,
      };
    case "RECOVERED":
      if (
        fromBundleId === null ||
        (updateStrategy !== "fingerprint" && updateStrategy !== "appVersion")
      ) {
        throw new FirebaseDatabaseDataError(source);
      }
      return {
        ...common,
        type: "RECOVERED",
        from_bundle_id: fromBundleId,
        update_strategy: updateStrategy,
      };
    default:
      throw new FirebaseDatabaseDataError(source);
  }
};
