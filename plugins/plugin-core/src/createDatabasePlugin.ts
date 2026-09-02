import { createDatabasePluginCrud } from "./databasePluginCrud";
import { DatabasePluginInputError } from "./databasePluginCrudValidation";
import { isChannelText, isRecord } from "./databasePluginCrudValidationFields";
import {
  validateBundleUpdateData,
  validateApiKeyUpdateData,
  validateReleaseUpdateData,
} from "./databasePluginCrudValidationMutations";
import {
  validateCreateData,
  validateResult,
} from "./databasePluginCrudValidationRows";
import { createTransactionDatabasePlugin } from "./databasePluginTransaction";
import {
  assertInsightsEventContract,
  assertInsightsExpiredReadContract,
  assertInsightsFailedReadContract,
  assertInsightsMaintenanceStepInputContract,
  assertInsightsPageContract,
  assertInsightsPreparingReadContract,
  assertInsightsReportPageResultContract,
  assertInsightsReportResultContract,
  InsightsContractError,
} from "./insightsContract";
import {
  readInsightsInstallationPageInput,
  readInsightsPageEventsInput,
} from "./insightsPageQuery";
import { readInsightsReportPageInput } from "./insightsReportPageQuery";
import { readInsightsReportQuery } from "./insightsReportQuery";
import type {
  BundlePatchRow,
  BundleRow,
  ChannelInsertInput,
  ChannelInsertResult,
  ChannelRow,
  ApiKeyRow,
  DatabaseBundleQueryWhere,
  DatabaseChange,
  DatabaseCommit,
  DatabaseCommitExpectation,
  DatabaseCommitResult,
  DatabasePlugin,
  DatabasePluginCrud,
  DatabasePluginImplementation,
  DatabaseWhere,
  InsightsInitialPublishedInstallationPage,
  InsightsInitialPublishedInstallationPageInput,
  InsightsInstallationPage,
  InsightsInstallationPageInput,
  InsightsLiveInstallationPage,
  InsightsLiveInstallationPageInput,
  InsightsPageEventsInput,
  InsightsPinnedInstallationPage,
  InsightsPinnedInstallationPageInput,
  InsightsPublishedInstallationContinuation,
  InsightsPublishedInstallationContinuationInput,
  InsightsPublishedInstallationPage,
  InsightsPublishedInstallationPageInput,
  InsightsReportInput,
  InsightsReportPageInput,
  ReleaseCatalogRow,
  ReleaseRow,
} from "./types/internal";

export {
  DatabasePluginInputError,
  type DatabasePluginInputErrorCode,
} from "./databasePluginCrud";

const PAGE_SIZE = 100;

const compareChannelRows = (left: ChannelRow, right: ChannelRow): number =>
  left.name < right.name ? -1 : left.name > right.name ? 1 : 0;

export class DatabaseAtomicCommitUnsupportedError extends Error {
  readonly name = "DatabaseAtomicCommitUnsupportedError";

  constructor(readonly pluginName: string) {
    super(
      `Database plugin "${pluginName}" cannot atomically commit changes across models.`,
    );
  }
}

/**
 * Internal provider signal for a delete rejected by a live reference.
 *
 * Provider implementations throw this after translating their native
 * foreign-key or reference-condition error. The public database contract
 * observes only the indexed `referenced` commit conflict.
 */
export class DatabaseRowReferencedError extends Error {
  readonly name = "DatabaseRowReferencedError";

  constructor() {
    super("The database row is still referenced.");
  }
}

class DatabaseCommitConflictError extends Error {
  readonly name = "DatabaseCommitConflictError";

  constructor(readonly result: DatabaseCommitResult) {
    super("Database commit precondition failed.");
  }
}

export type CreateDatabasePluginOptions = DatabasePlugin;

export type DatabasePluginAdapter = Omit<DatabasePlugin, "name">;

const toBundleWhere = (
  where: DatabaseBundleQueryWhere | undefined,
): readonly DatabaseWhere<"bundles">[] => {
  if (!where) return [];
  const filters: DatabaseWhere<"bundles">[] = [];
  if (where.platform !== undefined)
    filters.push({ field: "platform", value: where.platform });
  if (where.id?.eq !== undefined)
    filters.push({ field: "id", value: where.id.eq });
  if (where.id?.gt !== undefined)
    filters.push({ field: "id", operator: "gt", value: where.id.gt });
  if (where.id?.gte !== undefined)
    filters.push({ field: "id", operator: "gte", value: where.id.gte });
  if (where.id?.lt !== undefined)
    filters.push({ field: "id", operator: "lt", value: where.id.lt });
  if (where.id?.lte !== undefined)
    filters.push({ field: "id", operator: "lte", value: where.id.lte });
  if (where.id?.in !== undefined)
    filters.push({ field: "id", operator: "in", value: where.id.in });
  return filters;
};

const assertReleaseReferences = async (
  database: DatabasePluginCrud,
  row: ReleaseRow,
): Promise<void> => {
  const channel = await database.findOne({
    model: "channels",
    where: [{ field: "id", value: row.channel_id }],
  });
  if (channel === null) {
    throw new DatabasePluginInputError("invalid-data");
  }
  if (row.bundle_id !== null) {
    const bundle = await database.findOne({
      model: "bundles",
      where: [{ field: "id", value: row.bundle_id }],
    });
    if (bundle === null || bundle.platform !== row.platform) {
      throw new DatabasePluginInputError("invalid-data");
    }
  }
};

const applyChange = async (
  database: DatabasePluginCrud,
  change: DatabaseChange,
  changeIndex: number,
): Promise<void> => {
  switch (change.model) {
    case "bundles":
      switch (change.operation) {
        case "insert":
          await database.create({ model: "bundles", data: change.row });
          return;
        case "update": {
          const row = await database.update({
            model: "bundles",
            where: [{ field: "id", value: change.where.id }],
            update: change.update,
          });
          if (row === null) {
            throw new DatabaseCommitConflictError({
              committed: false,
              conflict: { changeIndex, reason: "not_found" },
            });
          }
          return;
        }
        case "delete":
          if (
            (await database.count({
              model: "releases",
              where: [{ field: "bundle_id", value: change.where.id }],
            })) > 0
          ) {
            throw new DatabaseCommitConflictError({
              committed: false,
              conflict: { changeIndex, reason: "referenced" },
            });
          }
          await database.delete({
            model: "bundles",
            where: [{ field: "id", value: change.where.id }],
          });
          return;
      }
    case "releases":
      switch (change.operation) {
        case "insert":
          await assertReleaseReferences(database, change.row);
          await database.create({ model: "releases", data: change.row });
          return;
        case "update": {
          const row = await database.update({
            model: "releases",
            where: [{ field: "id", value: change.where.id }],
            update: change.update,
          });
          if (row === null) {
            throw new DatabaseCommitConflictError({
              committed: false,
              conflict: { changeIndex, reason: "not_found" },
            });
          }
          return;
        }
        case "delete":
          await database.delete({
            model: "releases",
            where: [{ field: "id", value: change.where.id }],
          });
          return;
      }
    case "releaseCatalogs": {
      const current = await database.findOne({
        model: "release_catalogs",
        where: [{ field: "scope_key", value: change.row.scope_key }],
      });
      if (current === null) {
        await database.create({
          model: "release_catalogs",
          data: change.row,
        });
      } else {
        const { scope_key: _scopeKey, ...update } = change.row;
        await database.update({
          model: "release_catalogs",
          where: [{ field: "scope_key", value: change.row.scope_key }],
          update,
        });
      }
      return;
    }
    case "bundlePatches":
      switch (change.operation) {
        case "insert":
          await database.create({
            model: "bundle_patches",
            data: change.row,
          });
          return;
        case "delete":
          await database.delete({
            model: "bundle_patches",
            where: [{ field: "bundle_id", value: change.where.bundleId }],
          });
          return;
      }
    case "channels":
      switch (change.operation) {
        case "insert":
          await database.create({
            model: "channels",
            data: change.row,
            onConflict: change.onConflict,
          });
          return;
        case "delete": {
          const referencedReleases = await database.count({
            model: "releases",
            where: [{ field: "channel_id", value: change.where.id }],
          });
          if (referencedReleases > 0) {
            throw new DatabaseCommitConflictError({
              committed: false,
              conflict: { changeIndex, reason: "referenced" },
            });
          }
          try {
            await database.delete({
              model: "channels",
              where: [{ field: "id", value: change.where.id }],
            });
          } catch (error) {
            if (error instanceof DatabaseRowReferencedError) {
              throw new DatabaseCommitConflictError({
                committed: false,
                conflict: { changeIndex, reason: "referenced" },
              });
            }
            throw error;
          }
          return;
        }
      }
    case "apiKeys":
      switch (change.operation) {
        case "insert":
          await database.create({
            model: "api_keys",
            data: change.row,
            onConflict: change.onConflict,
          });
          return;
        case "update": {
          const row = await database.update({
            model: "api_keys",
            where: [{ field: "id", value: change.where.id }],
            update: { revoked_at_ms: change.update.revokedAtMs },
          });
          if (row === null) {
            throw new DatabaseCommitConflictError({
              committed: false,
              conflict: { changeIndex, reason: "not_found" },
            });
          }
          return;
        }
      }
  }
};

const expectationVersion = async (
  database: DatabasePluginCrud,
  expectation: DatabaseCommitExpectation,
): Promise<number | null> => {
  if (expectation.model === "releases") {
    const row = await database.findOne({
      model: "releases",
      where: [{ field: "id", value: expectation.id }],
      select: ["revision"],
    });
    return row?.revision ?? null;
  }
  const row = await database.findOne({
    model: "release_catalogs",
    where: [{ field: "scope_key", value: expectation.scopeKey }],
    select: ["generation"],
  });
  return row?.generation ?? null;
};

const applyExpectations = async (
  database: DatabasePluginCrud,
  expectations: readonly DatabaseCommitExpectation[],
): Promise<void> => {
  for (const expectation of expectations) {
    const expectedVersion =
      expectation.model === "releases"
        ? expectation.revision
        : expectation.generation;
    const actualVersion = await expectationVersion(database, expectation);
    if (actualVersion !== expectedVersion) {
      throw new DatabaseCommitConflictError({
        committed: false,
        conflict: {
          actualVersion,
          changeIndex: -1,
          expectedVersion,
          key:
            expectation.model === "releases"
              ? expectation.id
              : expectation.scopeKey,
          model: expectation.model,
          reason: "version_conflict",
        },
      });
    }
  }
};

const applyChanges = async (
  database: DatabasePluginCrud,
  input: DatabaseCommit,
): Promise<DatabaseCommitResult> => {
  await applyExpectations(database, input.expectations ?? []);
  for (const [changeIndex, change] of input.changes.entries()) {
    await applyChange(database, change, changeIndex);
  }
  return { committed: true };
};

const hasOnlyKeys = (
  value: Record<PropertyKey, unknown>,
  keys: readonly string[],
): boolean => {
  const actual = Reflect.ownKeys(value);
  return (
    actual.length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
};

const validateWhere = (
  where: unknown,
  field: "bundleId" | "id",
  validateValue: (value: unknown) => boolean = (value) =>
    typeof value === "string",
): void => {
  if (
    !isRecord(where) ||
    !hasOnlyKeys(where, [field]) ||
    !validateValue(Reflect.get(where, field))
  ) {
    throw new DatabasePluginInputError("invalid-data");
  }
};

const validateDatabaseChange = (change: unknown): void => {
  if (!isRecord(change)) {
    throw new DatabasePluginInputError("invalid-data");
  }
  switch (change.model) {
    case "bundles":
      switch (change.operation) {
        case "insert":
          if (!hasOnlyKeys(change, ["model", "operation", "row"])) {
            throw new DatabasePluginInputError("invalid-data");
          }
          validateCreateData("bundles", change.row);
          return;
        case "update":
          if (!hasOnlyKeys(change, ["model", "operation", "where", "update"])) {
            throw new DatabasePluginInputError("invalid-data");
          }
          validateWhere(change.where, "id");
          validateBundleUpdateData(change.update);
          return;
        case "delete":
          if (!hasOnlyKeys(change, ["model", "operation", "where"])) {
            throw new DatabasePluginInputError("invalid-data");
          }
          validateWhere(change.where, "id");
          return;
        default:
          throw new DatabasePluginInputError("invalid-operation");
      }
    case "bundlePatches":
      switch (change.operation) {
        case "insert":
          if (!hasOnlyKeys(change, ["model", "operation", "row"])) {
            throw new DatabasePluginInputError("invalid-data");
          }
          validateCreateData("bundle_patches", change.row);
          return;
        case "delete":
          if (!hasOnlyKeys(change, ["model", "operation", "where"])) {
            throw new DatabasePluginInputError("invalid-data");
          }
          validateWhere(change.where, "bundleId");
          return;
        default:
          throw new DatabasePluginInputError("invalid-operation");
      }
    case "releases":
      switch (change.operation) {
        case "insert":
          if (!hasOnlyKeys(change, ["model", "operation", "row"])) {
            throw new DatabasePluginInputError("invalid-data");
          }
          validateCreateData("releases", change.row);
          return;
        case "update":
          if (!hasOnlyKeys(change, ["model", "operation", "where", "update"])) {
            throw new DatabasePluginInputError("invalid-data");
          }
          validateWhere(change.where, "id");
          validateReleaseUpdateData(change.update);
          return;
        case "delete":
          if (!hasOnlyKeys(change, ["model", "operation", "where"])) {
            throw new DatabasePluginInputError("invalid-data");
          }
          validateWhere(change.where, "id");
          return;
        default:
          throw new DatabasePluginInputError("invalid-operation");
      }
    case "releaseCatalogs":
      if (
        change.operation !== "put" ||
        !hasOnlyKeys(change, ["model", "operation", "row"])
      ) {
        throw new DatabasePluginInputError("invalid-operation");
      }
      validateCreateData("release_catalogs", change.row);
      return;
    case "channels":
      switch (change.operation) {
        case "insert":
          if (
            !hasOnlyKeys(change, ["model", "operation", "row", "onConflict"]) ||
            change.onConflict !== "ignore"
          ) {
            throw new DatabasePluginInputError("invalid-operation");
          }
          validateCreateData("channels", change.row);
          return;
        case "delete":
          if (!hasOnlyKeys(change, ["model", "operation", "where"])) {
            throw new DatabasePluginInputError("invalid-data");
          }
          validateWhere(change.where, "id", isChannelText);
          return;
        default:
          throw new DatabasePluginInputError("invalid-operation");
      }
    case "apiKeys":
      switch (change.operation) {
        case "insert":
          if (
            !hasOnlyKeys(change, ["model", "operation", "row", "onConflict"]) ||
            change.onConflict !== "ignore"
          ) {
            throw new DatabasePluginInputError("invalid-operation");
          }
          validateCreateData("api_keys", change.row);
          return;
        case "update":
          if (!hasOnlyKeys(change, ["model", "operation", "where", "update"])) {
            throw new DatabasePluginInputError("invalid-data");
          }
          validateWhere(change.where, "id");
          if (!isRecord(change.update)) {
            throw new DatabasePluginInputError("invalid-data");
          }
          if (!hasOnlyKeys(change.update, ["revokedAtMs"])) {
            throw new DatabasePluginInputError("invalid-data");
          }
          validateApiKeyUpdateData({
            revoked_at_ms: change.update.revokedAtMs,
          });
          return;
        default:
          throw new DatabasePluginInputError("invalid-operation");
      }
    default:
      throw new DatabasePluginInputError("invalid-model");
  }
};

const validateDatabaseCommitExpectation = (expectation: unknown): void => {
  if (!isRecord(expectation)) {
    throw new DatabasePluginInputError("invalid-data");
  }
  if (expectation.model === "releases") {
    if (
      !hasOnlyKeys(expectation, ["model", "id", "revision"]) ||
      typeof expectation.id !== "string" ||
      !(
        expectation.revision === null ||
        (typeof expectation.revision === "number" &&
          Number.isSafeInteger(expectation.revision) &&
          expectation.revision >= 1)
      )
    ) {
      throw new DatabasePluginInputError("invalid-data");
    }
    return;
  }
  if (expectation.model === "releaseCatalogs") {
    if (
      !hasOnlyKeys(expectation, ["model", "scopeKey", "generation"]) ||
      typeof expectation.scopeKey !== "string" ||
      !(
        expectation.generation === null ||
        (typeof expectation.generation === "number" &&
          Number.isSafeInteger(expectation.generation) &&
          expectation.generation >= 1)
      )
    ) {
      throw new DatabasePluginInputError("invalid-data");
    }
    return;
  }
  throw new DatabasePluginInputError("invalid-model");
};

function validateDatabaseCommit(
  input: unknown,
): asserts input is DatabaseCommit {
  if (
    !isRecord(input) ||
    !Array.isArray(input.changes) ||
    (Object.hasOwn(input, "expectations")
      ? !hasOnlyKeys(input, ["changes", "expectations"]) ||
        !Array.isArray(input.expectations)
      : !hasOnlyKeys(input, ["changes"]))
  ) {
    throw new DatabasePluginInputError("invalid-data");
  }
  input.changes.forEach(validateDatabaseChange);
  if (Array.isArray(input.expectations)) {
    input.expectations.forEach(validateDatabaseCommitExpectation);
  }
}

const validateChannelInsertResult = (
  input: ChannelInsertInput,
  result: ChannelInsertResult,
): void => {
  validateResult("channels", result.row, undefined);
  if (
    typeof result.inserted !== "boolean" ||
    result.row.name !== input.row.name ||
    (result.inserted && result.row.id !== input.row.id)
  ) {
    throw new DatabasePluginInputError("invalid-result");
  }
};

const validateChannelDeleteResult = (
  result: Awaited<ReturnType<DatabasePluginImplementation["deleteChannel"]>>,
): void => {
  if (result.deleted) return;
  if (result.reason !== "not_found" && result.reason !== "not_empty") {
    throw new DatabasePluginInputError("invalid-result");
  }
};

type InsightsPageStateRules = {
  readonly preparing: boolean;
  readonly stale: boolean;
  readonly expired: boolean;
};

const insightsResultData = (
  value: unknown,
): Readonly<Record<string, unknown>> | null =>
  isRecord(value) &&
  (value.state === "ready" || value.state === "stale") &&
  isRecord(value.data)
    ? value.data
    : null;

const insightsPagePublication = (
  data: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> | null => {
  const consistency = data.consistency;
  if (!isRecord(consistency)) return null;
  const cutoff = consistency.cutoff;
  if (!isRecord(cutoff)) return null;
  return isRecord(cutoff.publication) ? cutoff.publication : null;
};

const validateInsightsPageResult = (
  value: unknown,
  input: { readonly cursor?: string; readonly limit: number },
  rules: InsightsPageStateRules,
): void => {
  if (!isRecord(value)) throw new InsightsContractError("invalid-response");
  if (value.state === "ready" || (rules.stale && value.state === "stale")) {
    assertInsightsPageContract(value, input.limit);
  } else if (rules.preparing && value.state === "preparing") {
    assertInsightsPreparingReadContract(value);
  } else if (value.state === "failed") {
    assertInsightsFailedReadContract(value);
  } else if (rules.expired && value.state === "expired") {
    assertInsightsExpiredReadContract(value);
  } else {
    throw new InsightsContractError("invalid-response");
  }
  const data = insightsResultData(value);
  if (
    data !== null &&
    (data.nextCursor === "" ||
      (input.cursor !== undefined && data.nextCursor === input.cursor))
  ) {
    throw new InsightsContractError("invalid-page");
  }
  if (
    data !== null &&
    input.cursor === undefined &&
    data.nextCursor === null &&
    isRecord(data.total) &&
    data.total.state === "exact" &&
    Array.isArray(data.data) &&
    data.total.value !== data.data.length
  ) {
    throw new InsightsContractError("invalid-page");
  }
};

const validateInsightsEventPageResult = (
  value: unknown,
  input: InsightsPageEventsInput,
): void => {
  validateInsightsPageResult(value, input, {
    preparing: true,
    stale: false,
    expired: false,
  });
  const data = insightsResultData(value);
  if (data === null) return;
  const consistency = data.consistency;
  const cutoff = isRecord(consistency) ? consistency.cutoff : null;
  if (
    !isRecord(cutoff) ||
    cutoff.beforeReceivedAtMs !== input.beforeReceivedAtMs ||
    !Array.isArray(data.data)
  ) {
    throw new InsightsContractError("invalid-page");
  }
  for (const row of data.data) {
    if (
      !isRecord(row) ||
      typeof row.received_at_ms !== "number" ||
      row.received_at_ms >= input.beforeReceivedAtMs ||
      (input.sinceReceivedAtMs !== undefined &&
        row.received_at_ms < input.sinceReceivedAtMs)
    ) {
      throw new InsightsContractError("invalid-page");
    }
    if (
      input.selector.kind === "installationId" &&
      (row.install_id !== input.selector.installId ||
        (row.type !== "UPDATE_APPLIED" && row.type !== "RECOVERED"))
    ) {
      throw new InsightsContractError("invalid-page");
    }
    if (
      input.selector.kind === "bundleId" &&
      !(
        (row.type === "UPDATE_APPLIED" &&
          row.to_bundle_id === input.selector.bundleId) ||
        (row.type === "RECOVERED" &&
          row.from_bundle_id === input.selector.bundleId)
      )
    ) {
      throw new InsightsContractError("invalid-page");
    }
  }
};

const validateInsightsInstallationPageResult = (
  value: unknown,
  input: InsightsInstallationPageInput,
): void => {
  const live = input.kind === "all" || input.kind === "installationId";
  const pinned = !live && input.publicationId !== undefined;
  const continuation = !live && input.cursor !== undefined;
  validateInsightsPageResult(value, input, {
    preparing: live || (!pinned && !continuation),
    stale: !live && (!pinned || continuation),
    expired: !live && (pinned || continuation),
  });
  const result = isRecord(value) ? value : null;
  const data = insightsResultData(value);
  if (input.kind === "installationId" && data !== null) {
    if (
      !Array.isArray(data.data) ||
      data.data.length > 1 ||
      data.nextCursor !== null ||
      data.hasNext !== false ||
      data.data.some(
        (row) => !isRecord(row) || row.install_id !== input.installId,
      )
    ) {
      throw new InsightsContractError("invalid-page");
    }
    return;
  }
  if (live) return;
  if (result?.state === "expired") {
    if (
      (input.publicationId === undefined && input.cursor === undefined) ||
      (input.publicationId !== undefined &&
        result.publicationId !== input.publicationId)
    ) {
      throw new InsightsContractError("invalid-response");
    }
    return;
  }
  if (data === null) return;
  const publication = insightsPagePublication(data);
  if (
    (input.publicationId !== undefined &&
      publication?.id !== input.publicationId) ||
    (result?.state === "ready" &&
      input.minAsOfMs !== undefined &&
      (typeof publication?.asOfMs !== "number" ||
        publication.asOfMs < input.minAsOfMs))
  ) {
    throw new InsightsContractError("invalid-page");
  }
};

const validateInsightsReportResult = (
  value: unknown,
  input: InsightsReportInput,
): void => {
  const query = input.query;
  assertInsightsReportResultContract(value);
  const result = isRecord(value) ? value : null;
  const data = insightsResultData(value);
  if (data === null) return;
  if (data.kind !== query.kind) {
    throw new InsightsContractError("invalid-response");
  }
  if (
    result?.state === "ready" &&
    input.minAsOfMs !== undefined &&
    (typeof data.asOfMs !== "number" || data.asOfMs < input.minAsOfMs)
  ) {
    throw new InsightsContractError("invalid-response");
  }
  if (query.kind === "bundleSummaries") {
    const summary = data.summary;
    const actualIds = Array.isArray(summary)
      ? summary.map((row) => (isRecord(row) ? row.bundleId : undefined))
      : [];
    if (
      actualIds.length !== query.bundleIds.length ||
      actualIds.some((id, index) => id !== query.bundleIds[index])
    ) {
      throw new InsightsContractError("invalid-response");
    }
  }
};

const validateInsightsReportPageResult = (
  value: unknown,
  input: InsightsReportPageInput,
): void => {
  assertInsightsReportPageResultContract(value, input.limit);
  const result = isRecord(value) ? value : null;
  if (result?.state === "expired") {
    if (result.publicationId !== input.publicationId) {
      throw new InsightsContractError("invalid-response");
    }
    return;
  }
  const data = insightsResultData(value);
  if (data === null) return;
  if (
    data.section !== input.section ||
    ((input.section === "movementSeries" ||
      input.section === "movementCohorts") &&
      data.metric !== input.metric) ||
    insightsPagePublication(data)?.id !== input.publicationId
  ) {
    throw new InsightsContractError("invalid-page");
  }
  if (
    input.section === "activeBundleSeries" &&
    input.bundleId !== undefined &&
    (!Array.isArray(data.data) ||
      data.data.some(
        (row) => !isRecord(row) || row.bundleId !== input.bundleId,
      ))
  ) {
    throw new InsightsContractError("invalid-page");
  }
};

const invalidInsightsResult = (operation: () => void): void => {
  try {
    operation();
  } catch {
    throw new DatabasePluginInputError("invalid-result");
  }
};

export const createDatabasePluginAdapter = (
  name: string,
  implementation: DatabasePluginImplementation,
): DatabasePluginAdapter => {
  const crud = createDatabasePluginCrud(implementation);
  const transaction = implementation.transaction;
  const executeCommit = implementation.commit
    ? implementation.commit
    : async (input: DatabaseCommit): Promise<DatabaseCommitResult> => {
        if (transaction) {
          try {
            return await transaction((database) =>
              applyChanges(createTransactionDatabasePlugin(database), input),
            );
          } catch (error) {
            if (error instanceof DatabaseCommitConflictError) {
              return error.result;
            }
            throw error;
          }
        }
        if (
          (input.expectations?.length ?? 0) > 0 ||
          input.changes.length > 1 ||
          input.changes.some(
            (change) =>
              change.model === "channels" && change.operation === "delete",
          )
        ) {
          throw new DatabaseAtomicCommitUnsupportedError(name);
        }
        try {
          return await applyChanges(crud, input);
        } catch (error) {
          if (error instanceof DatabaseCommitConflictError) return error.result;
          throw error;
        }
      };
  const commit = async (
    input: DatabaseCommit,
  ): Promise<DatabaseCommitResult> => {
    validateDatabaseCommit(input);
    return executeCommit(input);
  };

  const findApiKeyByHash = (
    database: DatabasePluginCrud,
    hash: string,
  ): Promise<ApiKeyRow | null> =>
    database.findOne({
      model: "api_keys",
      where: [{ field: "hash", value: hash }],
    });

  async function pageInstallations(
    input: InsightsLiveInstallationPageInput,
  ): Promise<InsightsLiveInstallationPage>;
  async function pageInstallations(
    input: InsightsInitialPublishedInstallationPageInput,
  ): Promise<InsightsInitialPublishedInstallationPage>;
  async function pageInstallations(
    input: InsightsPinnedInstallationPageInput,
  ): Promise<InsightsPinnedInstallationPage>;
  async function pageInstallations(
    input: InsightsPublishedInstallationContinuationInput,
  ): Promise<InsightsPublishedInstallationContinuation>;
  async function pageInstallations(
    input: InsightsPublishedInstallationPageInput,
  ): Promise<InsightsPublishedInstallationPage>;
  async function pageInstallations(
    input: InsightsInstallationPageInput,
  ): Promise<InsightsInstallationPage>;
  async function pageInstallations(
    input: InsightsInstallationPageInput,
  ): Promise<InsightsInstallationPage> {
    const canonicalInput = readInsightsInstallationPageInput(input);
    const result =
      await implementation.insights.pageInstallations(canonicalInput);
    invalidInsightsResult(() =>
      validateInsightsInstallationPageResult(result, canonicalInput),
    );
    return result;
  }

  return {
    models: {
      bundles: {
        findById: (id): Promise<BundleRow | null> =>
          crud.findOne({
            model: "bundles",
            where: [{ field: "id", value: id }],
          }),
        findMany: (query): Promise<readonly BundleRow[]> =>
          crud.findMany({
            model: "bundles",
            where: toBundleWhere(query.where),
            limit: query.limit,
            offset: query.offset,
            orderBy: [query.orderBy],
          }),
        count: (where) =>
          crud.count({ model: "bundles", where: toBundleWhere(where) }),
      },
      bundlePatches: {
        async findByBundleIds(bundleIds): Promise<readonly BundlePatchRow[]> {
          if (bundleIds.length === 0) return [];
          const rows: BundlePatchRow[] = [];
          for (let offset = 0; ; offset += PAGE_SIZE) {
            const page = await crud.findMany({
              model: "bundle_patches",
              where: [{ field: "bundle_id", operator: "in", value: bundleIds }],
              limit: PAGE_SIZE,
              offset,
              orderBy: [{ field: "id", direction: "asc" }],
            });
            rows.push(...page);
            if (page.length < PAGE_SIZE) return rows;
          }
        },
      },
      releases: {
        findById: (id): Promise<ReleaseRow | null> =>
          crud.findOne({
            model: "releases",
            where: [{ field: "id", value: id }],
          }),
        findMany(input): Promise<readonly ReleaseRow[]> {
          if (
            !Number.isSafeInteger(input.limit) ||
            input.limit <= 0 ||
            (input.afterReleaseId !== undefined &&
              input.beforeReleaseId !== undefined)
          ) {
            throw new DatabasePluginInputError("invalid-query");
          }
          const query = crud.findMany({
            model: "releases",
            where: [
              ...(input.afterReleaseId === undefined
                ? []
                : [
                    {
                      field: "id" as const,
                      operator: "gt" as const,
                      value: input.afterReleaseId,
                    },
                  ]),
              ...(input.beforeReleaseId === undefined
                ? []
                : [
                    {
                      field: "id" as const,
                      operator: "lt" as const,
                      value: input.beforeReleaseId,
                    },
                  ]),
              ...(input.bundleId === undefined
                ? []
                : [{ field: "bundle_id" as const, value: input.bundleId }]),
              ...(input.channelId === undefined
                ? []
                : [{ field: "channel_id" as const, value: input.channelId }]),
              ...(input.enabled === undefined
                ? []
                : [{ field: "enabled" as const, value: input.enabled }]),
              ...(input.platform === undefined
                ? []
                : [{ field: "platform" as const, value: input.platform }]),
              ...(input.targetAppVersion === undefined
                ? []
                : [
                    {
                      field: "target_app_version" as const,
                      value: input.targetAppVersion,
                    },
                  ]),
            ],
            limit: input.limit,
            offset: 0,
            orderBy: [
              {
                field: "id",
                direction:
                  input.afterReleaseId === undefined
                    ? ("desc" as const)
                    : ("asc" as const),
              },
            ],
          });
          return input.afterReleaseId === undefined
            ? query
            : query.then((rows) => [...rows].reverse());
        },
        findManyByScope(input): Promise<readonly ReleaseRow[]> {
          if (
            input.consistency !== "strong" ||
            !Number.isSafeInteger(input.limit) ||
            input.limit <= 0
          ) {
            throw new DatabasePluginInputError("invalid-query");
          }
          return crud.findMany({
            model: "releases",
            where: [
              { field: "scope_key", value: input.scopeKey },
              ...(input.afterReleaseId === undefined
                ? []
                : [
                    {
                      field: "id" as const,
                      operator: "gt" as const,
                      value: input.afterReleaseId,
                    },
                  ]),
            ],
            limit: input.limit,
            offset: 0,
            orderBy: [{ field: "id", direction: "asc" }],
          });
        },
      },
      releaseCatalogs: {
        findByScopeKey: (scopeKey): Promise<ReleaseCatalogRow | null> =>
          crud.findOne({
            model: "release_catalogs",
            where: [{ field: "scope_key", value: scopeKey }],
          }),
        findMany(input): Promise<readonly ReleaseCatalogRow[]> {
          if (!Number.isSafeInteger(input.limit) || input.limit <= 0) {
            throw new DatabasePluginInputError("invalid-query");
          }
          return crud.findMany({
            model: "release_catalogs",
            where:
              input.afterScopeKey === undefined
                ? []
                : [
                    {
                      field: "scope_key",
                      operator: "gt",
                      value: input.afterScopeKey,
                    },
                  ],
            limit: input.limit,
            offset: 0,
            orderBy: [{ field: "scope_key", direction: "asc" }],
          });
        },
      },
      channels: {
        async insert(input) {
          if (input.onConflict !== "returnExisting") {
            throw new DatabasePluginInputError("invalid-operation");
          }
          validateCreateData("channels", input.row);
          const result = await implementation.insertChannel(input);
          validateChannelInsertResult(input, result);
          return result;
        },
        async list(_input) {
          const channels: ChannelRow[] = [];
          for (let offset = 0; ; offset += PAGE_SIZE) {
            const page = await crud.findMany({
              model: "channels",
              orderBy: [{ field: "name", direction: "asc" }],
              limit: PAGE_SIZE,
              offset,
            });
            channels.push(...page);
            if (page.length < PAGE_SIZE) {
              channels.sort(compareChannelRows);
              return { channels };
            }
          }
        },
        async delete(input) {
          if (!isChannelText(input.id)) {
            throw new DatabasePluginInputError("invalid-data");
          }
          const result = await implementation.deleteChannel(input);
          validateChannelDeleteResult(result);
          return result;
        },
      },
      insights: {
        async append(row) {
          try {
            assertInsightsEventContract(row);
          } catch {
            throw new DatabasePluginInputError("invalid-data");
          }
          await implementation.insights.append(row);
        },
        async runMaintenanceStep(input) {
          try {
            assertInsightsMaintenanceStepInputContract(input);
          } catch {
            throw new DatabasePluginInputError("invalid-query");
          }
          await implementation.insights.runMaintenanceStep(input);
        },
        async pageEvents(input) {
          const canonicalInput = readInsightsPageEventsInput(input);
          const result =
            await implementation.insights.pageEvents(canonicalInput);
          invalidInsightsResult(() =>
            validateInsightsEventPageResult(result, canonicalInput),
          );
          return result;
        },
        pageInstallations,
        async getReport(input) {
          const { query, minAsOfMs } = readInsightsReportQuery(input);
          const canonicalInput = {
            query,
            ...(minAsOfMs === undefined ? {} : { minAsOfMs }),
          };
          const result =
            await implementation.insights.getReport(canonicalInput);
          invalidInsightsResult(() =>
            validateInsightsReportResult(result, canonicalInput),
          );
          return result;
        },
        async pageReport(input) {
          const canonicalInput = readInsightsReportPageInput(input);
          const result =
            await implementation.insights.pageReport(canonicalInput);
          invalidInsightsResult(() =>
            validateInsightsReportPageResult(result, canonicalInput),
          );
          return result;
        },
      },
      apiKeys: {
        async create(row) {
          const run = async (database: DatabasePluginCrud) => {
            if ((await findApiKeyByHash(database, row.hash)) !== null) {
              return "existing" as const;
            }
            await database.create({ model: "api_keys", data: row });
            return "created" as const;
          };
          return transaction
            ? transaction((database) =>
                run(createTransactionDatabasePlugin(database)),
              )
            : run(crud);
        },
        findByHash: (hash) => findApiKeyByHash(crud, hash),
        list: () =>
          crud.findMany({
            model: "api_keys",
            orderBy: [
              { field: "created_at_ms", direction: "desc" },
              { field: "id", direction: "asc" },
            ],
            limit: Number.MAX_SAFE_INTEGER,
            offset: 0,
          }),
        async revoke({ id, revokedAtMs }) {
          return crud.update({
            model: "api_keys",
            where: [{ field: "id", value: id }],
            update: { revoked_at_ms: revokedAtMs },
          });
        },
      },
    },
    commit,
    ...(implementation.dispose ? { dispose: implementation.dispose } : {}),
  };
};

export const createDatabasePlugin = (
  options: CreateDatabasePluginOptions,
): DatabasePlugin => ({ ...options });
