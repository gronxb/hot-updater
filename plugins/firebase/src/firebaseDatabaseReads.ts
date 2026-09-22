import { DatabasePluginInputError } from "@hot-updater/plugin-core";
import type {
  DatabaseModel,
  DatabaseImplementationResult,
  DatabasePluginImplementation,
  DatabaseWhere,
  FindManyDatabaseImplementationInput,
} from "@hot-updater/plugin-core/internal";
import {
  Filter,
  type Query,
  type QueryDocumentSnapshot,
  type DocumentReference,
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
  firebaseChannelIdDocumentId,
  requireFirebaseDocumentKey,
  type FirebaseDatabaseCollections,
} from "./firebaseDatabasePersistence";
import { FirebaseDatabaseConstraintError } from "./firebaseDatabaseState";

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
    select?: readonly string[],
  ) => {
    if (select !== undefined) {
      const value = document.data();
      if (typeof value !== "object" || value === null)
        throw new DatabasePluginInputError("invalid-result");
      const key = Reflect.get(value, documentKey(model));
      if (
        typeof key !== "string" ||
        document.id !==
          (model === "channels" ? firebaseChannelDocumentId(key) : key)
      )
        throw new FirebaseDatabaseConstraintError(`${model}.id.document-key`);
      // The factory validates selected fields. Retain the physical key invariant here.
      return value as DatabaseImplementationResult;
    }
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
  const documentKey = (model: DatabaseModel) =>
    model === "channels"
      ? "name"
      : model === "release_catalogs"
        ? "scope_key"
        : "id";
  const fields = (
    model: DatabaseModel,
    select?: readonly string[],
    orderBy: readonly { field: string }[] = [],
  ) =>
    select === undefined
      ? undefined
      : [
          ...new Set([
            ...select,
            documentKey(model),
            ...orderBy.map(({ field }) => field),
          ]),
        ];
  const getDocument = async (
    reference: DocumentReference,
    fieldMask?: string[],
  ) => {
    if (fieldMask !== undefined) {
      const [document] = await (transaction
        ? transaction.getAll(reference, { fieldMask })
        : reference.firestore.getAll(reference, { fieldMask }));
      return document;
    }
    return transaction ? transaction.get(reference) : reference.get();
  };
  // Snapshot cursors also need Firestore's implicit inequality ordering fields.
  const cursorOrder = (input: {
    orderBy?: readonly { field: string; direction: "asc" | "desc" }[];
    where?: Where;
  }) => {
    const order = [...(input.orderBy ?? [])];
    const direction = order.at(-1)?.direction ?? "asc";
    const inequalities = new Set(
      input.where
        ?.filter(({ operator }) =>
          ["gt", "gte", "lt", "lte", "ne", "not_in"].includes(operator ?? "eq"),
        )
        .map(({ field }) => field),
    );
    for (const field of [...inequalities].sort())
      if (!order.some((clause) => clause.field === field))
        order.push({ field, direction });
    return order;
  };
  const orderedQuery = (input: FindManyDatabaseImplementationInput): Query => {
    let query = filterQuery(sources[input.model], input.where);
    for (const clause of input.orderBy ?? []) {
      if (clause.nulls !== undefined)
        throw new DatabasePluginInputError("invalid-operation");
      query = query.orderBy(clause.field, clause.direction);
    }
    const select = fields(input.model, input.select, cursorOrder(input));
    return select === undefined ? query : query.select(...select);
  };
  const get = (query: Query) =>
    transaction ? transaction.get(query) : query.get();
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
        input.model === "channels" &&
        input.where?.length === 1 &&
        condition.field === "id" &&
        typeof condition.value === "string" &&
        (condition.operator ?? "eq") === "eq" &&
        !("mode" in condition && condition.mode === "insensitive")
      ) {
        // Reading even an absent registry document serializes competing IDs.
        const registry = await getDocument(
          collections.settings.doc(
            firebaseChannelIdDocumentId(condition.value),
          ),
        );
        if (!registry.exists) return null;
        const channel = parseFirebaseChannelRow(
          registry.data(),
          `settings/${registry.id}`,
        );
        const document = await getDocument(
          collections.channels.doc(firebaseChannelDocumentId(channel.name)),
        );
        if (channel.id !== condition.value || !document.exists)
          throw new FirebaseDatabaseConstraintError("channels.id.registry");
        const row = parseFirebaseChannelRow(
          document.data(),
          `channels/${document.id}`,
        );
        if (row.id !== channel.id || row.name !== channel.name)
          throw new FirebaseDatabaseConstraintError("channels.id.registry");
        return row;
      }
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
        const document = await getDocument(
          reference,
          fields(input.model, input.select),
        );
        return document.exists
          ? parse(input.model, document, input.select)
          : null;
      }
      let query = filterQuery(sources[input.model], input.where)
        .offset(0)
        .limit(1);
      const select = fields(input.model, input.select);
      if (select !== undefined) query = query.select(...select);
      const result = await (transaction ? transaction.get(query) : query.get());
      return result.docs[0] === undefined
        ? null
        : parse(input.model, result.docs[0], input.select);
    },
    async findMany(input) {
      if (input.distinctOn !== undefined)
        throw new DatabasePluginInputError("invalid-operation");
      if (input.limit === 0 || empty(input.where)) return [];
      await ensureMigrated();
      const parts = splitInputs(input);
      if (parts !== undefined) {
        const orderBy = input.orderBy?.length
          ? input.orderBy
          : [{ field: documentKey(input.model), direction: "asc" as const }];
        const comparisonOrder = cursorOrder({ ...input, orderBy });
        const streams = await Promise.all(
          parts.map(async (part) => {
            const query = orderedQuery({
              ...part,
              orderBy,
            } as FindManyDatabaseImplementationInput);
            return {
              query,
              head: (await get(query.limit(1))).docs[0] as
                | QueryDocumentSnapshot
                | undefined,
            };
          }),
        );
        const compare = (
          left: QueryDocumentSnapshot,
          right: QueryDocumentSnapshot,
        ) => {
          for (const { field, direction } of comparisonOrder) {
            const a = left.get(field),
              b = right.get(field);
            const comparison =
              typeof a === "string" && typeof b === "string"
                ? Buffer.compare(Buffer.from(a), Buffer.from(b))
                : a === b
                  ? 0
                  : a === null
                    ? -1
                    : b === null
                      ? 1
                      : a < b
                        ? -1
                        : 1;
            if (comparison !== 0)
              return direction === "asc" ? comparison : -comparison;
          }
          // Firestore implicitly orders equal values by document name in the last direction.
          const comparison = Buffer.compare(
            Buffer.from(left.id),
            Buffer.from(right.id),
          );
          return comparisonOrder.at(-1)?.direction === "desc"
            ? -comparison
            : comparison;
        };
        const rows: DatabaseImplementationResult[] = [];
        let skipped = 0;
        while (rows.length < input.limit) {
          let next: (typeof streams)[number] | undefined;
          for (const stream of streams)
            if (
              stream.head &&
              (!next?.head || compare(stream.head, next.head) < 0)
            )
              next = stream;
          if (!next?.head) break;
          if (skipped < input.offset) skipped++;
          else rows.push(parse(input.model, next.head, input.select));
          if (rows.length === input.limit) break;
          next.head = (
            await get(next.query.startAfter(next.head).limit(1))
          ).docs[0];
        }
        return rows;
      }
      const query = orderedQuery(input);
      let continuation = query.offset(input.offset);
      const rows: DatabaseImplementationResult[] = [];
      while (rows.length < input.limit) {
        const limit = Math.min(1000, input.limit - rows.length);
        const result = await get(continuation.limit(limit));
        rows.push(
          ...result.docs.map((document) =>
            parse(input.model, document, input.select),
          ),
        );
        if (result.docs.length < limit) break;
        continuation = query.startAfter(result.docs[result.docs.length - 1]);
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
