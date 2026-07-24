import type { GetBundlesArgs, UpdateInfo } from "@hot-updater/core";

import type {
  CountDatabaseInput,
  CountDatabaseModel,
  CreateDatabaseInput,
  CreateDatabaseModel,
  DeleteDatabaseInput,
  DeleteDatabaseModel,
  FindManyDatabaseInput,
  FindManyDatabaseModel,
  FindOneDatabaseInput,
  FindOneDatabaseModel,
  UpdateDatabaseInput,
  UpdateDatabaseModel,
} from "./databaseOperations";
import type { DatabaseSelect } from "./databaseQuery";
import type { DatabaseModel, DatabaseRow } from "./databaseRows";

export type DatabaseImplementationResult = {
  readonly [TModel in DatabaseModel]: Partial<DatabaseRow<TModel>>;
}[DatabaseModel];

export type CreateDatabaseImplementationInput = {
  readonly [TModel in CreateDatabaseModel]: CreateDatabaseInput<
    TModel,
    DatabaseSelect<TModel> | undefined
  >;
}[CreateDatabaseModel];

export type UpdateDatabaseImplementationInput = {
  readonly [TModel in UpdateDatabaseModel]: UpdateDatabaseInput<
    TModel,
    DatabaseSelect<TModel> | undefined
  >;
}[UpdateDatabaseModel];

export type DeleteDatabaseImplementationInput = {
  readonly [TModel in DeleteDatabaseModel]: DeleteDatabaseInput<TModel>;
}[DeleteDatabaseModel];

export type CountDatabaseImplementationInput = {
  readonly [TModel in CountDatabaseModel]: CountDatabaseInput<TModel>;
}[CountDatabaseModel];

export type UpdateBundleDatabaseImplementationInput = UpdateDatabaseInput<
  "bundles",
  DatabaseSelect<"bundles"> | undefined
>;

export type CountBundlesDatabaseImplementationInput =
  CountDatabaseInput<"bundles">;

export type FindOneDatabaseImplementationInput = {
  readonly [TModel in FindOneDatabaseModel]: FindOneDatabaseInput<
    TModel,
    DatabaseSelect<TModel> | undefined
  >;
}[FindOneDatabaseModel];

export type FindManyDatabaseImplementationInput = {
  readonly [TModel in FindManyDatabaseModel]: Omit<
    FindManyDatabaseInput<TModel, DatabaseSelect<TModel> | undefined>,
    "limit" | "offset"
  > & {
    readonly limit: number;
    readonly offset: number;
  };
}[FindManyDatabaseModel];

export interface TransactionDatabasePluginImplementation {
  create(
    input: CreateDatabaseImplementationInput,
  ): Promise<DatabaseImplementationResult>;
  update(
    input: UpdateDatabaseImplementationInput,
  ): Promise<DatabaseImplementationResult | null>;
  delete(input: DeleteDatabaseImplementationInput): Promise<void>;
  count(input: CountDatabaseImplementationInput): Promise<number>;
  findOne(
    input: FindOneDatabaseImplementationInput,
  ): Promise<DatabaseImplementationResult | null>;
  findMany(
    input: FindManyDatabaseImplementationInput,
  ): Promise<readonly DatabaseImplementationResult[]>;
}

export interface DatabasePluginImplementation {
  create(
    input: CreateDatabaseImplementationInput,
  ): Promise<DatabaseImplementationResult>;
  update(
    input: UpdateDatabaseImplementationInput,
  ): Promise<DatabaseImplementationResult | null>;
  delete(input: DeleteDatabaseImplementationInput): Promise<void>;
  count(input: CountDatabaseImplementationInput): Promise<number>;
  findOne(
    input: FindOneDatabaseImplementationInput,
  ): Promise<DatabaseImplementationResult | null>;
  findMany(
    input: FindManyDatabaseImplementationInput,
  ): Promise<readonly DatabaseImplementationResult[]>;
  getChannels?: () => Promise<string[]>;
  getUpdateInfo?: (args: GetBundlesArgs) => Promise<UpdateInfo | null>;
  transaction?: <TResult>(
    callback: (
      transaction: TransactionDatabasePluginImplementation,
    ) => Promise<TResult>,
  ) => Promise<TResult>;
  onUnmount?: () => Promise<void>;
}

export interface DatabasePluginLifecycleHooks {
  readonly onDatabaseUpdated?: () => Promise<void>;
}
