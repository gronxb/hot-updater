import type { MaybePromise } from "@hot-updater/plugin-core";
import type {
  CreateIndexesOptions,
  Document,
  IndexSpecification,
  OptionalUnlessRequiredId,
  Sort,
} from "mongodb";

export interface MongoSessionRuntime {
  endSession(): MaybePromise<void>;
  withTransaction<TResult>(operation: () => Promise<TResult>): Promise<TResult>;
}

export interface MongoCursorRuntime<TRow extends Document> {
  sort(sort: Sort): MongoCursorRuntime<TRow>;
  project<TProjection extends Document>(
    projection: object,
  ): MongoCursorRuntime<TProjection>;
  toArray(): Promise<TRow[]>;
}

export interface MongoOperationOptions {
  readonly session?: MongoSessionRuntime;
  readonly upsert?: boolean;
}

export interface MongoCollectionRuntime<TRow extends Document> {
  findOne(
    filter: object,
    options?: MongoOperationOptions,
  ): Promise<TRow | null>;
  find(
    filter: object,
    options?: MongoOperationOptions,
  ): MongoCursorRuntime<TRow>;
  updateOne(
    filter: object,
    update: object,
    options?: MongoOperationOptions,
  ): Promise<unknown>;
  deleteMany(filter: object, options?: MongoOperationOptions): Promise<unknown>;
  insertMany(
    rows: readonly OptionalUnlessRequiredId<TRow>[],
    options?: MongoOperationOptions,
  ): Promise<unknown>;
  createIndex(
    index: IndexSpecification,
    options?: CreateIndexesOptions,
  ): Promise<unknown>;
}

export interface MongoDatabaseRuntime {
  collection<TRow extends Document = Document>(
    name: string,
  ): MongoCollectionRuntime<TRow>;
  createCollection(name: string): Promise<unknown>;
}

export interface MongoClientRuntime {
  db(): MongoDatabaseRuntime;
  startSession?(): MongoSessionRuntime;
}
