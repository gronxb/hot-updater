import { DatabasePluginInputError } from "./databasePluginCrudValidationErrors";
import { isRecord } from "./databasePluginCrudValidationFields";
import { validateCreateData } from "./databasePluginCrudValidationRows";
import type {
  BundleEventRow,
  InsightsEventFilter,
  InsightsInstallationRow,
  InsightsModel,
} from "./types";
import { isUUIDv7 } from "./uuidv7";

const encoder = new TextEncoder();

/** Exact UTF-8 byte ordering, without case folding or Unicode normalization. */
export const compareInsightsText = (left: string, right: string): number => {
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    if (a[index] !== b[index]) return a[index]! - b[index]!;
  }
  return a.length - b.length;
};

const isWellFormedText = (value: string): boolean => {
  for (const character of value) {
    const point = character.codePointAt(0)!;
    if (point >= 0xd800 && point <= 0xdfff) return false;
  }
  return true;
};

const isIdentity = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= 255 &&
  isWellFormedText(value);

const isText = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && isWellFormedText(value);

const isTimestamp = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const isLimit = (value: unknown): value is number =>
  isTimestamp(value) && value >= 1 && value <= 101;

const hasOnlyKeys = (
  value: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): boolean => Object.keys(value).every((key) => keys.includes(key));

const hasScope = (value: Readonly<Record<string, unknown>>): boolean =>
  (value.platform === "ios" || value.platform === "android") &&
  isText(value.channel);

const isBundleFilter = (value: unknown, withKind = false): boolean => {
  if (!isRecord(value) || !hasScope(value)) return false;
  const keys = ["platform", "channel", "type", ...(withKind ? ["kind"] : [])];
  return value.type === "RECOVERED"
    ? isText(value.fromBundleId) &&
        hasOnlyKeys(value, [...keys, "fromBundleId"])
    : (value.type === "UPDATE_APPLIED" || value.type === "RELEASE_ADOPTED") &&
        isText(value.toBundleId) &&
        hasOnlyKeys(value, [...keys, "toBundleId"]);
};

const isEventFilter = (value: unknown): boolean => {
  if (!isRecord(value)) return false;
  if (value.kind === "all") return hasOnlyKeys(value, ["kind"]);
  if (value.kind === "installationMovement") {
    return (
      isIdentity(value.installId) && hasOnlyKeys(value, ["kind", "installId"])
    );
  }
  return value.kind === "bundle" && isBundleFilter(value, true);
};

const validateRow = (
  model: "bundle_events" | "bundle_installations",
  row: unknown,
  result = false,
): void => {
  try {
    validateCreateData(model, row);
    if (
      !isRecord(row) ||
      typeof row.id !== "string" ||
      !isUUIDv7(row.id) ||
      Object.values(row).some(
        (value) => typeof value === "string" && !isWellFormedText(value),
      )
    ) {
      throw new DatabasePluginInputError("invalid-data");
    }
  } catch (error) {
    if (result) throw new DatabasePluginInputError("invalid-result");
    throw error;
  }
};

/** Prepare the full latest-state candidate; the provider owns winning writes. */
export const toInsightsInstallationRow = (
  event: BundleEventRow,
): InsightsInstallationRow => {
  validateRow("bundle_events", event);
  return {
    id: event.id,
    install_id: event.install_id,
    user_id: event.user_id,
    username: event.username,
    to_bundle_id: event.to_bundle_id,
    type: event.type,
    platform: event.platform,
    app_version: event.app_version,
    channel: event.channel,
    cohort: event.cohort,
    received_at_ms: event.received_at_ms,
  };
};

/** Release adoption and unchanged lifecycle reports are not bundle movements. */
export const isInsightsMovementEvent = (
  event: Pick<BundleEventRow, "type">,
): boolean => event.type === "UPDATE_APPLIED" || event.type === "RECOVERED";

export const matchesInsightsEventFilter = (
  event: BundleEventRow,
  filter: InsightsEventFilter,
): boolean => {
  if (filter.kind === "all") return true;
  if (filter.kind === "installationMovement") {
    return (
      event.install_id === filter.installId && isInsightsMovementEvent(event)
    );
  }
  return (
    event.type === filter.type &&
    event.platform === filter.platform &&
    event.channel === filter.channel &&
    (filter.type === "RECOVERED"
      ? event.from_bundle_id === filter.fromBundleId
      : event.to_bundle_id === filter.toBundleId)
  );
};

const invalidQuery = (): never => {
  throw new DatabasePluginInputError("invalid-query");
};
const invalidResult = (): never => {
  throw new DatabasePluginInputError("invalid-result");
};
const validateCount = (count: number): number =>
  isTimestamp(count) ? count : invalidResult();

/** Validate custom and bundled providers at the same public boundary. */
export const createValidatedInsightsModel = (
  model: InsightsModel,
): InsightsModel => ({
  async record(input) {
    if (!isRecord(input) || !hasOnlyKeys(input, ["event", "installation"])) {
      throw new DatabasePluginInputError("invalid-data");
    }
    const expected = toInsightsInstallationRow(input.event);
    validateRow("bundle_installations", input.installation);
    if (
      Object.entries(expected).some(
        ([field, value]) => Reflect.get(input.installation, field) !== value,
      )
    ) {
      throw new DatabasePluginInputError("invalid-data");
    }
    await model.record(input);
  },
  async listEvents(input) {
    if (
      !isRecord(input) ||
      !hasOnlyKeys(input, [
        "filter",
        "sinceMs",
        "beforeReceivedAtMs",
        "after",
        "limit",
      ]) ||
      !isEventFilter(input.filter) ||
      !isLimit(input.limit) ||
      !isTimestamp(input.beforeReceivedAtMs) ||
      (input.sinceMs !== undefined && !isTimestamp(input.sinceMs))
    )
      invalidQuery();
    const sinceMs = input.sinceMs ?? 0;
    if (
      sinceMs > input.beforeReceivedAtMs ||
      (input.after !== undefined &&
        (!isRecord(input.after) ||
          !hasOnlyKeys(input.after, ["receivedAtMs", "id"]) ||
          !isTimestamp(input.after.receivedAtMs) ||
          typeof input.after.id !== "string" ||
          !isUUIDv7(input.after.id) ||
          input.after.receivedAtMs < sinceMs ||
          input.after.receivedAtMs >= input.beforeReceivedAtMs))
    )
      invalidQuery();
    const rows = await model.listEvents(input);
    if (!Array.isArray(rows) || rows.length > input.limit) invalidResult();
    let previous = input.after;
    for (const row of rows) {
      validateRow("bundle_events", row, true);
      if (
        row.received_at_ms < sinceMs ||
        row.received_at_ms >= input.beforeReceivedAtMs ||
        !matchesInsightsEventFilter(row, input.filter) ||
        (previous !== undefined &&
          (row.received_at_ms > previous.receivedAtMs ||
            (row.received_at_ms === previous.receivedAtMs &&
              row.id >= previous.id)))
      )
        invalidResult();
      previous = { receivedAtMs: row.received_at_ms, id: row.id };
    }
    return rows;
  },
  async findInstallations(input) {
    if (!isRecord(input)) invalidQuery();
    if ("installId" in input) {
      if (!hasOnlyKeys(input, ["installId"]) || !isIdentity(input.installId))
        invalidQuery();
    } else if (
      !hasOnlyKeys(input, ["userId", "afterInstallId", "limit"]) ||
      !isIdentity(input.userId) ||
      !isLimit(input.limit) ||
      (input.afterInstallId !== undefined && !isIdentity(input.afterInstallId))
    )
      invalidQuery();
    const rows = await model.findInstallations(input);
    if (
      !Array.isArray(rows) ||
      rows.length > ("installId" in input ? 1 : input.limit)
    )
      invalidResult();
    let previous = "installId" in input ? undefined : input.afterInstallId;
    for (const row of rows) {
      validateRow("bundle_installations", row, true);
      if (
        "installId" in input
          ? row.install_id !== input.installId
          : row.user_id !== input.userId ||
            (previous !== undefined &&
              compareInsightsText(row.install_id, previous) <= 0)
      )
        invalidResult();
      previous = row.install_id;
    }
    return rows;
  },
  async countInstallations(input) {
    if (
      !isRecord(input) ||
      !hasOnlyKeys(input, ["platform", "channel", "sinceMs", "bundleId"]) ||
      !hasScope(input) ||
      !isTimestamp(input.sinceMs) ||
      (input.bundleId !== undefined && !isText(input.bundleId))
    )
      invalidQuery();
    return validateCount(await model.countInstallations(input));
  },
  async countEvents(input) {
    if (
      !isRecord(input) ||
      !hasOnlyKeys(input, ["filter", "sinceMs", "beforeReceivedAtMs"]) ||
      !isBundleFilter(input.filter) ||
      !isTimestamp(input.sinceMs) ||
      !isTimestamp(input.beforeReceivedAtMs) ||
      input.sinceMs > input.beforeReceivedAtMs
    )
      invalidQuery();
    return validateCount(await model.countEvents(input));
  },
});
