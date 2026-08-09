import type { ClientSession } from "mongodb";

export type MongoAnalyticsDocument = Readonly<Record<string, unknown>>;

type MongoAnalyticsOperationOptions = {
  readonly session?: ClientSession;
};

type MongoAnalyticsFindOptions = MongoAnalyticsOperationOptions & {
  readonly projection?: MongoAnalyticsDocument;
};

type MongoAnalyticsCreateIndexOptions = MongoAnalyticsOperationOptions & {
  readonly name: string;
  readonly unique?: boolean;
};

type MongoAnalyticsCreateCollectionOptions = MongoAnalyticsOperationOptions & {
  readonly validationAction: "error";
  readonly validationLevel: "strict";
  readonly validator: MongoAnalyticsDocument;
};

export interface MongoAnalyticsCursor {
  limit(value: number): this;
  sort(value: Readonly<Record<string, 1 | -1>>): this;
  toArray(): Promise<readonly unknown[]>;
}

export interface MongoAnalyticsListCursor {
  toArray(): Promise<readonly unknown[]>;
}

export interface MongoAnalyticsCollection {
  createIndex(
    key: Readonly<Record<string, 1 | -1>>,
    options: MongoAnalyticsCreateIndexOptions,
  ): Promise<string>;
  find(
    filter?: MongoAnalyticsDocument,
    options?: MongoAnalyticsFindOptions,
  ): MongoAnalyticsCursor;
  findOne(
    filter: MongoAnalyticsDocument,
    options?: MongoAnalyticsOperationOptions,
  ): Promise<unknown | null>;
  insertOne(
    document: MongoAnalyticsDocument,
    options?: MongoAnalyticsOperationOptions,
  ): Promise<unknown>;
  listIndexes(
    options?: MongoAnalyticsOperationOptions,
  ): MongoAnalyticsListCursor;
  updateOne(
    filter: MongoAnalyticsDocument,
    update: MongoAnalyticsDocument,
    options?: MongoAnalyticsOperationOptions & { readonly upsert?: boolean },
  ): Promise<unknown>;
}

export interface MongoAnalyticsDatabase {
  collection(name: string): MongoAnalyticsCollection;
  command(
    command: MongoAnalyticsDocument,
    options?: MongoAnalyticsOperationOptions,
  ): Promise<unknown>;
  createCollection(
    name: string,
    options: MongoAnalyticsCreateCollectionOptions,
  ): Promise<unknown>;
  listCollections(
    filter: MongoAnalyticsDocument,
    options?: MongoAnalyticsOperationOptions,
  ): MongoAnalyticsListCursor;
}

export type MongoAnalyticsConfig = {
  readonly database: MongoAnalyticsDatabase;
  readonly session?: ClientSession;
};

export function mongoOperationOptions(
  session: ClientSession | undefined,
): MongoAnalyticsOperationOptions {
  return session === undefined ? {} : { session };
}
