import { DatabasePluginInputError } from "@hot-updater/plugin-core";
import type {
  DatabaseModel,
  DatabaseImplementationResult,
  DatabasePluginImplementation,
  DatabaseWhere,
} from "@hot-updater/plugin-core/internal";
import {
  Filter,
  type Query,
  type Transaction,
  type WhereFilterOp,
} from "firebase-admin/firestore";

import {
  parseFirebaseApiKeyRow,
  parseFirebaseBundleEventRow,
  parseFirebaseBundleRow,
  parseFirebaseChannelRow,
  parseFirebasePatchRow,
  parseFirebaseReleaseCatalogRow,
  parseFirebaseReleaseRow,
} from "./firebaseDatabaseParser";
import {
  firebaseChannelDocumentId,
  requireFirebaseDocumentKey,
  type FirebaseDatabaseCollections,
} from "./firebaseDatabasePersistence";

type Where = readonly {
  [T in DatabaseModel]: DatabaseWhere<T>;
}[DatabaseModel][];

const operators: Record<string, WhereFilterOp> = {
  eq: "==",
  ne: "!=",
  gt: ">",
  gte: ">=",
  lt: "<",
  lte: "<=",
  in: "in",
  not_in: "not-in",
};

// Unsupported predicates must fail explicitly, never fetch a collection to filter it.
const filterQuery = (query: Query, where: Where = []): Query => {
  const filters = where.map((condition) => {
    const operator = operators[condition.operator ?? "eq"];
    if (
      operator === undefined ||
      ("mode" in condition && condition.mode === "insensitive")
    )
      throw new DatabasePluginInputError("invalid-operation");
    return Filter.where(condition.field, operator, condition.value);
  });
  if (where.some((condition) => condition.connector === "OR")) {
    const filter = filters.reduce((previous, current, index) =>
      where[index]?.connector === "OR"
        ? Filter.or(previous, current)
        : Filter.and(previous, current),
    );
    return query.where(filter);
  }
  for (const condition of where)
    query = query.where(
      condition.field,
      operators[condition.operator ?? "eq"],
      condition.value,
    );
  return query;
};

// Firestore permits at most 30 disjunctions. Shard finite ID sets, never broaden
// the query to the collection when a page contains more owners than that.
const splitInputs = <T extends { readonly where?: Where }>(
  input: T,
): T[] | undefined => {
  const condition = input.where?.find(
    (clause) =>
      clause.operator === "in" &&
      Array.isArray(clause.value) &&
      clause.value.length > 30,
  );
  if (condition === undefined || !Array.isArray(condition.value))
    return undefined;
  if (input.where?.some(({ connector }) => connector === "OR"))
    throw new DatabasePluginInputError("invalid-operation");
  const values = [...new Set(condition.value)];
  const result: T[] = [];
  for (let offset = 0; offset < values.length; offset += 30)
    result.push({
      ...input,
      where: input.where?.map((clause) =>
        clause === condition
          ? { ...clause, value: values.slice(offset, offset + 30) }
          : clause,
      ),
    });
  return result;
};

export const createFirebaseReads = (
  collections: FirebaseDatabaseCollections,
  ensureMigrated: () => Promise<void>,
  transaction?: Transaction,
): Pick<DatabasePluginImplementation, "findOne" | "findMany" | "count"> => {
  const sources = {
    bundles: collections.bundles,
    bundle_patches: collections.bundlePatches,
    bundle_events: collections.bundleEvents,
    channels: collections.channels,
    api_keys: collections.apiKeys,
    releases: collections.releases,
    release_catalogs: collections.releaseCatalogs,
  };
  const parsers = {
    bundles: parseFirebaseBundleRow,
    bundle_patches: parseFirebasePatchRow,
    bundle_events: parseFirebaseBundleEventRow,
    channels: parseFirebaseChannelRow,
    api_keys: parseFirebaseApiKeyRow,
    releases: parseFirebaseReleaseRow,
    release_catalogs: parseFirebaseReleaseCatalogRow,
  };
  const parse = (
    model: DatabaseModel,
    document: { id: string; data(): unknown },
  ) => {
    const row = parsers[model](document.data(), `${model}/${document.id}`);
    if (model === "channels") {
      if (
        !("name" in row) ||
        document.id !== firebaseChannelDocumentId(row.name)
      )
        throw new Error("Firebase channel document key is inconsistent");
      return row;
    }
    return requireFirebaseDocumentKey(model, document.id, row);
  };
  const empty = (where: Where = []) =>
    !where.some(({ connector }) => connector === "OR") &&
    where.some(
      (condition) =>
        condition.operator === "in" &&
        Array.isArray(condition.value) &&
        condition.value.length === 0,
    );
  const reads: Pick<
    DatabasePluginImplementation,
    "findOne" | "findMany" | "count"
  > = {
    async findOne(input) {
      await ensureMigrated();
      if (empty(input.where)) return null;
      const parts = splitInputs(input);
      if (parts !== undefined) {
        for (const part of parts) {
          const row = await reads.findOne(part);
          if (row !== null) return row;
        }
        return null;
      }
      const [condition] = input.where ?? [];
      const key =
        input.model === "release_catalogs"
          ? "scope_key"
          : input.model === "channels"
            ? "name"
            : "id";
      if (
        input.where?.length === 1 &&
        condition.field === key &&
        (condition.operator === undefined || condition.operator === "eq") &&
        typeof condition.value === "string" &&
        !("mode" in condition && condition.mode === "insensitive")
      ) {
        const id =
          input.model === "channels"
            ? firebaseChannelDocumentId(condition.value)
            : condition.value;
        const reference = sources[input.model].doc(id);
        const document = await (transaction
          ? transaction.get(reference)
          : reference.get());
        return document.exists ? parse(input.model, document) : null;
      }
      const query = filterQuery(sources[input.model], input.where)
        .offset(0)
        .limit(1);
      const result = await (transaction ? transaction.get(query) : query.get());
      return result.docs[0] === undefined
        ? null
        : parse(input.model, result.docs[0]);
    },
    async findMany(input) {
      if (input.distinctOn !== undefined)
        throw new DatabasePluginInputError("invalid-operation");
      if (input.limit === 0 || empty(input.where)) return [];
      const parts = splitInputs(input);
      if (parts !== undefined) {
        const rows: DatabaseImplementationResult[] = [];
        for (const part of parts)
          rows.push(
            ...(await reads.findMany({
              ...part,
              limit: input.offset + input.limit,
              offset: 0,
            })),
          );
        rows.sort((left, right) => {
          for (const { field, direction } of input.orderBy ?? [
            { field: "id", direction: "asc" },
          ]) {
            const a = Reflect.get(left, field),
              b = Reflect.get(right, field);
            const comparison =
              a === b ? 0 : a === null ? -1 : b === null ? 1 : a < b ? -1 : 1;
            if (comparison !== 0)
              return direction === "asc" ? comparison : -comparison;
          }
          return 0;
        });
        return rows.slice(input.offset, input.offset + input.limit);
      }
      await ensureMigrated();
      let query = filterQuery(sources[input.model], input.where);
      for (const clause of input.orderBy ?? []) {
        if (clause.nulls !== undefined)
          throw new DatabasePluginInputError("invalid-operation");
        query = query.orderBy(clause.field, clause.direction);
      }
      const rows: DatabaseImplementationResult[] = [];
      while (rows.length < input.limit) {
        const limit = Math.min(1000, input.limit - rows.length);
        const page = query.offset(input.offset + rows.length).limit(limit);
        const result = await (transaction ? transaction.get(page) : page.get());
        rows.push(
          ...result.docs.map((document) => parse(input.model, document)),
        );
        if (result.docs.length < limit) break;
      }
      return rows;
    },
    async count(input) {
      if (input.distinct !== undefined)
        throw new DatabasePluginInputError("invalid-operation");
      if (empty(input.where)) return 0;
      const parts = splitInputs(input);
      if (parts !== undefined) {
        let count = 0;
        for (const part of parts) count += await reads.count(part);
        return count;
      }
      await ensureMigrated();
      let source = filterQuery(sources[input.model], input.where);
      if (input.model === "bundle_events")
        source = source.orderBy("received_at_ms", "desc").orderBy("id", "desc");
      const query = source.count();
      const result = await (transaction ? transaction.get(query) : query.get());
      return result.data().count;
    },
  };
  return reads;
};
