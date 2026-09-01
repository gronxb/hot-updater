import {
  DatabasePluginInputError,
  InsightsQueryNotReadyError,
} from "@hot-updater/plugin-core";
import {
  databaseFields,
  INSIGHTS_EVENT_ID_PATTERN,
  INSIGHTS_MAINTENANCE_INPUT_MAX_BYTES,
} from "@hot-updater/plugin-core/internal";
import type { Document, MongoClient, ReadConcern } from "mongodb";

import {
  assertMongoInsightsEventRow,
  mongoInsightsEventIndexes,
} from "../adapters/mongodbInsights";

const STATE_ID = "event-pages";
const STATE_COLLECTION = "private_hot_updater_insights_preparation";
const EVENT_COLLECTION = "bundle_events";
const nullableString = { bsonType: ["string", "null"] };
export const mongoInsightsEventValidator = {
  $and: [
    {
      $jsonSchema: {
        bsonType: "object",
        required: [...databaseFields.bundle_events, "_id"],
        properties: {
          _id: { bsonType: "objectId" },
          id: {
            bsonType: "string",
            pattern: INSIGHTS_EVENT_ID_PATTERN.source,
            minLength: 36,
            maxLength: 36,
          },
          type: {
            enum: [
              "UPDATE_APPLIED",
              "RECOVERED",
              "RELEASE_ADOPTED",
              "UNCHANGED",
            ],
          },
          install_id: { bsonType: "string" },
          user_id: nullableString,
          username: nullableString,
          from_bundle_id: nullableString,
          from_release_id: nullableString,
          to_bundle_id: { bsonType: "string" },
          to_release_id: nullableString,
          platform: { enum: ["ios", "android"] },
          app_version: { bsonType: "string" },
          channel: { bsonType: "string" },
          cohort: { bsonType: "string" },
          update_strategy: { enum: [null, "appVersion", "fingerprint"] },
          fingerprint_hash: nullableString,
          sdk_version: nullableString,
          received_at_ms: {
            bsonType: ["int", "long", "double"],
            minimum: 0,
            maximum: Number.MAX_SAFE_INTEGER,
          },
        },
      },
    },
    {
      $expr: {
        $cond: [
          { $isNumber: "$received_at_ms" },
          { $eq: [{ $mod: ["$received_at_ms", 1] }, 0] },
          false,
        ],
      },
    },
    {
      $or: [
        {
          type: { $in: ["UPDATE_APPLIED", "RECOVERED", "RELEASE_ADOPTED"] },
          from_bundle_id: { $type: "string" },
          update_strategy: { $in: ["appVersion", "fingerprint"] },
        },
        {
          type: "UNCHANGED",
          from_bundle_id: { $type: "null" },
          update_strategy: { $type: "null" },
        },
      ],
    },
  ],
};

type Phase = "installing" | "auditing" | "upper" | "ready" | "failed";
interface Preparation extends Document {
  _id: string;
  version: 1;
  revision: number;
  phase: Phase;
  collectionUuid: string;
  validator: Document;
  previousValidator: Document;
  upperId: string | null;
  afterId: string | null;
  processed: number;
}

export class MongoInsightsPreparationConflictError extends Error {
  readonly name = "MongoInsightsPreparationConflictError";
  constructor() {
    super(
      "Another MongoDB Insights preparation step advanced the checkpoint. Retry the bounded step.",
    );
  }
}

const view = (state: Preparation) => ({
  state: state.phase === "upper" ? ("auditing" as const) : state.phase,
  processed: state.processed,
});

/** Explicit maintenance. Drain writers before prepare(); resume guarded append
 * only after it succeeds. Keep other schema maintenance excluded throughout the
 * audit and existing raw events immutable. Strict DB validation fences new rows
 * while runStep() audits existing rows without modifying them.
 * This prepares native pages only; it does not prepare report source capture.
 */
export const createMongoInsightsPreparation = (client: MongoClient) => {
  const db = client.db(undefined, {
    readPreference: "primary",
    // MongoDB normalizes this supported literal with ReadConcern.fromOptions;
    // DbOptions' narrower type must not force an eager optional-peer import.
    readConcern: { level: "local" } as ReadConcern,
    writeConcern: { w: "majority" },
  });
  const events = db.collection(EVENT_COLLECTION);
  const states = db.collection<Preparation>(STATE_COLLECTION);
  // Loading generic /db must not eagerly load the optional MongoDB peer.
  const bson = async () => (await import("mongodb")).BSON;
  const metadata = async () => {
    const collection = await db
      .listCollections({ name: EVENT_COLLECTION }, { nameOnly: false })
      .next();
    if (!collection || !collection.info?.uuid)
      throw new InsightsQueryNotReadyError();
    return { ...collection, options: collection.options ?? {} };
  };
  const state = async (): Promise<Preparation> => {
    const current = await states.findOne({ _id: STATE_ID });
    if (!current) throw new InsightsQueryNotReadyError();
    if (
      current.version !== 1 ||
      !Number.isSafeInteger(current.revision) ||
      current.revision < 0 ||
      !Number.isSafeInteger(current.processed) ||
      current.processed < 0 ||
      !["installing", "auditing", "upper", "ready", "failed"].includes(
        current.phase,
      ) ||
      typeof current.collectionUuid !== "string" ||
      typeof current.validator !== "object" ||
      current.validator === null ||
      (current.afterId !== null && typeof current.afterId !== "string") ||
      (current.upperId !== null && typeof current.upperId !== "string") ||
      ((current.phase === "auditing" || current.phase === "upper") &&
        current.upperId === null)
    ) {
      throw new DatabasePluginInputError("invalid-result");
    }
    return current;
  };
  const sameValidator = async (
    current: Preparation,
    collection: Awaited<ReturnType<typeof metadata>>,
  ) => {
    const { EJSON } = await bson();
    return (
      EJSON.stringify(collection.info!.uuid, { relaxed: false }) ===
        current.collectionUuid &&
      EJSON.stringify(collection.options.validator ?? {}, {
        relaxed: false,
      }) === EJSON.stringify(current.validator, { relaxed: false })
    );
  };
  const sameFence = async (
    current: Preparation,
    collection: Awaited<ReturnType<typeof metadata>>,
  ) =>
    (await sameValidator(current, collection)) &&
    collection.options.validationLevel === "strict" &&
    collection.options.validationAction === "error";
  const indexes = async () => {
    const found = await events.listIndexes().toArray();
    return mongoInsightsEventIndexes.map((expected) => ({
      expected,
      existing: found.find(({ name }) => name === expected.name),
      ready: found.some(
        (index) =>
          index.name === expected.name &&
          JSON.stringify(Object.entries(index.key)) ===
            JSON.stringify(Object.entries(expected.key)) &&
          (!("unique" in expected) || index.unique === true) &&
          !index.hidden &&
          !index.sparse &&
          index.partialFilterExpression === undefined &&
          (index.collation === undefined ||
            index.collation.locale === "simple"),
      ),
    }));
  };
  const advance = async (
    current: Preparation,
    changes: Partial<Preparation>,
  ) => {
    const result = await states.updateOne(
      { _id: STATE_ID, revision: current.revision },
      {
        $set: changes,
        $inc: { revision: 1 },
      },
    );
    if (result.matchedCount !== 1)
      throw new MongoInsightsPreparationConflictError();
    return { ...current, ...changes, revision: current.revision + 1 };
  };

  return {
    async prepare(input: { readonly writersDrained: true }) {
      if (input?.writersDrained !== true)
        throw new DatabasePluginInputError("invalid-query");
      const { EJSON } = await bson();
      try {
        await db.createCollection(EVENT_COLLECTION);
      } catch (error) {
        if (
          typeof error !== "object" ||
          error === null ||
          Reflect.get(error, "code") !== 48
        )
          throw error;
      }
      let collection = await metadata();
      let current = await states.findOne({ _id: STATE_ID });
      if (
        current &&
        current.phase !== "installing" &&
        current.phase !== "failed" &&
        (await sameFence(current, collection)) &&
        (await indexes()).every(({ ready }) => ready)
      )
        return view(current);

      if (!current || current.phase !== "installing") {
        const validator =
          current && (await sameValidator(current, collection))
            ? current.validator
            : Object.keys(collection.options.validator ?? {}).length === 0
              ? mongoInsightsEventValidator
              : {
                  $and: [
                    collection.options.validator,
                    mongoInsightsEventValidator,
                  ],
                };
        const replacement: Preparation = {
          _id: STATE_ID,
          version: 1,
          revision: (current?.revision ?? -1) + 1,
          phase: "installing",
          collectionUuid: EJSON.stringify(collection.info!.uuid, {
            relaxed: false,
          }),
          validator,
          previousValidator: collection.options.validator ?? {},
          upperId: null,
          afterId: null,
          processed: 0,
        };
        if (current) {
          const saved = await states.replaceOne(
            { _id: STATE_ID, revision: current.revision },
            replacement,
          );
          if (saved.matchedCount !== 1)
            throw new MongoInsightsPreparationConflictError();
        } else {
          await states.insertOne(replacement);
        }
        current = replacement;
      }
      try {
        if (
          EJSON.stringify(collection.info!.uuid, { relaxed: false }) !==
          current.collectionUuid
        )
          throw new InsightsQueryNotReadyError();
        const actualValidator = EJSON.stringify(
          collection.options.validator ?? {},
          { relaxed: false },
        );
        if (
          actualValidator !==
            EJSON.stringify(current.previousValidator, { relaxed: false }) &&
          actualValidator !==
            EJSON.stringify(current.validator, { relaxed: false })
        )
          throw new InsightsQueryNotReadyError();
        await db.command({
          collMod: EVENT_COLLECTION,
          validator: current.validator,
          validationLevel: "strict",
          validationAction: "error",
          writeConcern: { w: "majority" },
        });
        for (const index of await indexes()) {
          if (index.ready) continue;
          if (index.existing) await events.dropIndex(index.expected.name);
          await events.createIndex(index.expected.key, {
            name: index.expected.name,
            collation: { locale: "simple" },
            ...("unique" in index.expected ? { unique: true } : {}),
          });
        }
        collection = await metadata();
        const upper = await events
          .find({}, { projection: { _id: 1 }, promoteValues: false })
          .hint("_id_")
          .sort({ _id: -1 })
          .limit(1)
          .toArray();
        const upperId = upper[0]
          ? EJSON.stringify(upper[0]._id, { relaxed: false })
          : null;
        current = await advance(current, {
          validator: collection.options.validator ?? {},
          upperId,
          phase:
            upperId === null
              ? "ready"
              : upperId === '{"$minKey":1}'
                ? "upper"
                : "auditing",
        });
        return view(current);
      } catch (error) {
        await advance(current, { phase: "failed" }).catch(() => undefined);
        throw error;
      }
    },

    async runStep(input: {
      readonly maxItems: number;
      readonly maxRequests: number;
    }) {
      if (
        !Number.isSafeInteger(input.maxItems) ||
        input.maxItems < 2 ||
        input.maxItems > 200 ||
        !Number.isSafeInteger(input.maxRequests) ||
        input.maxRequests < 5
      )
        throw new DatabasePluginInputError("invalid-query");
      const current = await state();
      if (
        current.phase === "installing" ||
        current.phase === "failed" ||
        !(await sameFence(current, await metadata()))
      )
        throw new InsightsQueryNotReadyError();
      if (current.phase === "ready")
        return { ...view(current), itemsRead: 0, requests: 2 };
      const { deserialize, EJSON, MinKey } = await bson();
      const upper = EJSON.parse(current.upperId!, { relaxed: false });
      const after =
        current.afterId === null
          ? undefined
          : EJSON.parse(current.afterId, { relaxed: false });
      // Read only the BSON size and key first. A hostile legacy document can
      // then poison preparation durably without entering a maintenance input.
      // Native $ne preserves cross-BSON ordering and can fetch the excluded
      // checkpoint once, so reserve one physical candidate on continuation.
      const readRange = (projection: Document | undefined, limit: number) =>
        current.phase === "upper"
          ? events
              .find(
                { _id: upper },
                {
                  singleBatch: true,
                  ...(projection
                    ? { projection, promoteValues: false }
                    : { raw: true }),
                },
              )
              .hint("_id_")
              .limit(1)
              .batchSize(1)
              .toArray()
          : events
              .find(after === undefined ? {} : { _id: { $ne: after } }, {
                singleBatch: true,
                ...(projection
                  ? { projection, promoteValues: false }
                  : { raw: true }),
              })
              .hint("_id_")
              .sort({ _id: 1 })
              .min({ _id: after === undefined ? new MinKey() : after })
              .max({ _id: upper })
              .limit(limit)
              .batchSize(limit)
              .toArray();
      const candidateLimit =
        current.phase === "upper"
          ? 1
          : input.maxItems - (after === undefined ? 0 : 1);
      const sizeRows = await readRange(
        { _id: 1, documentBytes: { $bsonSize: "$$ROOT" } },
        candidateLimit,
      );
      let documentBytes = 0;
      let selected = 0;
      for (const row of sizeRows) {
        const rowBytes = Number(row.documentBytes);
        if (
          !Number.isSafeInteger(rowBytes) ||
          rowBytes < 1 ||
          rowBytes > INSIGHTS_MAINTENANCE_INPUT_MAX_BYTES
        ) {
          await advance(current, { phase: "failed" });
          throw new DatabasePluginInputError("invalid-result");
        }
        if (documentBytes + rowBytes > INSIGHTS_MAINTENANCE_INPUT_MAX_BYTES)
          break;
        documentBytes += rowBytes;
        selected++;
      }
      const rawRows =
        selected === 0 ? [] : await readRange(undefined, selected);
      const rows = rawRows.map((raw) =>
        deserialize(raw as unknown as Uint8Array),
      );
      const exactIds = rawRows.map(
        (raw) =>
          deserialize(raw as unknown as Uint8Array, { promoteValues: false })
            ._id,
      );
      if (rows.length > input.maxItems)
        throw new DatabasePluginInputError("invalid-result");
      let afterId: string | null = null;
      try {
        for (const row of rows) {
          const index = rows.indexOf(row);
          const metadataId = sizeRows[index]?._id;
          if (
            EJSON.stringify(exactIds[index], { relaxed: false }) !==
            EJSON.stringify(metadataId, { relaxed: false })
          )
            throw new DatabasePluginInputError("invalid-result");
          const { _id: _rawId, ...event } = row;
          assertMongoInsightsEventRow(event);
        }
        if (rows.length > 0) {
          afterId = EJSON.stringify(sizeRows[selected - 1]!._id, {
            relaxed: false,
          });
          if (typeof afterId !== "string")
            throw new DatabasePluginInputError("invalid-result");
        }
      } catch (error) {
        await advance(current, { phase: "failed" });
        throw error;
      }
      const next = await advance(current, {
        phase:
          current.phase === "upper"
            ? "ready"
            : rows.length === 0
              ? "upper"
              : "auditing",
        afterId,
        processed: current.processed + rows.length,
      });
      return {
        ...view(next),
        itemsRead: rows.length,
        requests: rows.length === 0 ? 4 : 5,
      };
    },

    async ensureReady(): Promise<void> {
      const current = await state();
      if (
        current.phase !== "ready" ||
        !(await sameFence(current, await metadata())) ||
        !(await indexes()).every(({ ready }) => ready)
      )
        throw new InsightsQueryNotReadyError();
    },
  };
};
