import type { GetBundlesArgs, UpdateInfo } from "@hot-updater/core";

import type {
  DatabaseSelect,
  DatabaseSortBy,
  DatabaseWhere,
  SelectedDatabaseRow,
} from "./databaseQuery";
import type {
  BundleRow,
  ChannelRow,
  DatabaseModel,
  DatabaseRow,
} from "./databaseRows";

export type CreateDatabaseInput<
  TModel extends DatabaseModel,
  TSelect extends DatabaseSelect<TModel> | undefined = undefined,
> = {
  readonly model: TModel;
  readonly data: DatabaseRow<TModel>;
  readonly select?: TSelect;
};

export type UpdateBundleDatabaseInput<
  TSelect extends DatabaseSelect<"bundles"> | undefined = undefined,
> = {
  readonly model: "bundles";
  readonly where: readonly DatabaseWhere<"bundles">[];
  readonly update: Partial<Omit<BundleRow, "id">>;
  readonly select?: TSelect;
};

export type DatabaseDeleteModel = "bundle_patches" | "bundles";
export type DeleteDatabaseInput<TModel extends DatabaseDeleteModel> = {
  readonly model: TModel;
  readonly where: readonly DatabaseWhere<TModel>[];
};

export type CountBundlesDatabaseInput = {
  readonly model: "bundles";
  readonly where?: readonly DatabaseWhere<"bundles">[];
};

export type DatabaseFindOneModel = "bundles" | "channels";
export type FindOneDatabaseInput<
  TModel extends DatabaseFindOneModel,
  TSelect extends DatabaseSelect<TModel> | undefined = undefined,
> = {
  readonly model: TModel;
  readonly where?: readonly DatabaseWhere<TModel>[];
  readonly select?: TSelect;
};

export type FindManyDatabaseInput<
  TModel extends DatabaseModel,
  TSelect extends DatabaseSelect<TModel> | undefined = undefined,
> = {
  readonly model: TModel;
  readonly where?: readonly DatabaseWhere<TModel>[];
  readonly limit?: number;
  readonly offset?: number;
  readonly sortBy?: DatabaseSortBy<TModel>;
  readonly select?: TSelect;
};

export interface TransactionDatabaseAdapter {
  create<
    TModel extends DatabaseModel,
    TSelect extends DatabaseSelect<TModel> | undefined = undefined,
  >(
    input: CreateDatabaseInput<TModel, TSelect>,
  ): Promise<SelectedDatabaseRow<TModel, TSelect>>;
  update<TSelect extends DatabaseSelect<"bundles"> | undefined = undefined>(
    input: UpdateBundleDatabaseInput<TSelect>,
  ): Promise<SelectedDatabaseRow<"bundles", TSelect> | null>;
  delete<TModel extends DatabaseDeleteModel>(
    input: DeleteDatabaseInput<TModel>,
  ): Promise<void>;
  count(input: CountBundlesDatabaseInput): Promise<number>;
  findOne<
    TModel extends DatabaseFindOneModel,
    TSelect extends DatabaseSelect<TModel> | undefined = undefined,
  >(
    input: FindOneDatabaseInput<TModel, TSelect>,
  ): Promise<SelectedDatabaseRow<TModel, TSelect> | null>;
  findMany<
    TModel extends DatabaseModel,
    TSelect extends DatabaseSelect<TModel> | undefined = undefined,
  >(
    input: FindManyDatabaseInput<TModel, TSelect>,
  ): Promise<SelectedDatabaseRow<TModel, TSelect>[]>;
}

export interface DatabaseAdapter<TContext = unknown> {
  readonly name: string;
  create<
    TModel extends DatabaseModel,
    TSelect extends DatabaseSelect<TModel> | undefined = undefined,
  >(
    input: CreateDatabaseInput<TModel, TSelect>,
    context?: TContext,
  ): Promise<SelectedDatabaseRow<TModel, TSelect>>;
  update<TSelect extends DatabaseSelect<"bundles"> | undefined = undefined>(
    input: UpdateBundleDatabaseInput<TSelect>,
    context?: TContext,
  ): Promise<SelectedDatabaseRow<"bundles", TSelect> | null>;
  delete<TModel extends DatabaseDeleteModel>(
    input: DeleteDatabaseInput<TModel>,
    context?: TContext,
  ): Promise<void>;
  count(input: CountBundlesDatabaseInput, context?: TContext): Promise<number>;
  findOne<
    TModel extends DatabaseFindOneModel,
    TSelect extends DatabaseSelect<TModel> | undefined = undefined,
  >(
    input: FindOneDatabaseInput<TModel, TSelect>,
    context?: TContext,
  ): Promise<SelectedDatabaseRow<TModel, TSelect> | null>;
  findMany<
    TModel extends DatabaseModel,
    TSelect extends DatabaseSelect<TModel> | undefined = undefined,
  >(
    input: FindManyDatabaseInput<TModel, TSelect>,
    context?: TContext,
  ): Promise<SelectedDatabaseRow<TModel, TSelect>[]>;
  getUpdateInfo?: (
    args: GetBundlesArgs,
    context?: TContext,
  ) => Promise<UpdateInfo | null>;
  transaction?: <TResult>(
    callback: (transaction: TransactionDatabaseAdapter) => Promise<TResult>,
    context?: TContext,
  ) => Promise<TResult>;
  onDatabaseUpdated?: () => Promise<void>;
  onUnmount?: () => Promise<void>;
}

export type DatabaseImplementationResult = {
  readonly [TModel in DatabaseModel]: Partial<DatabaseRow<TModel>>;
}[DatabaseModel];

export type CreateDatabaseImplementationInput = {
  readonly [TModel in DatabaseModel]: CreateDatabaseInput<
    TModel,
    DatabaseSelect<TModel> | undefined
  >;
}[DatabaseModel];

export type UpdateBundleDatabaseImplementationInput = UpdateBundleDatabaseInput<
  DatabaseSelect<"bundles"> | undefined
>;

export type DeleteDatabaseImplementationInput = {
  readonly [TModel in DatabaseDeleteModel]: DeleteDatabaseInput<TModel>;
}[DatabaseDeleteModel];

export type FindOneDatabaseImplementationInput = {
  readonly [TModel in DatabaseFindOneModel]: FindOneDatabaseInput<
    TModel,
    DatabaseSelect<TModel> | undefined
  >;
}[DatabaseFindOneModel];

export type FindManyDatabaseImplementationInput = {
  readonly [TModel in DatabaseModel]: Omit<
    FindManyDatabaseInput<TModel, DatabaseSelect<TModel> | undefined>,
    "limit" | "offset"
  > & {
    readonly limit: number;
    readonly offset: number;
  };
}[DatabaseModel];

export interface TransactionDatabaseAdapterImplementation {
  create(
    input: CreateDatabaseImplementationInput,
  ): Promise<DatabaseImplementationResult>;
  update(
    input: UpdateBundleDatabaseImplementationInput,
  ): Promise<Partial<BundleRow> | null>;
  delete(input: DeleteDatabaseImplementationInput): Promise<void>;
  count(input: CountBundlesDatabaseInput): Promise<number>;
  findOne(
    input: FindOneDatabaseImplementationInput,
  ): Promise<Partial<BundleRow> | Partial<ChannelRow> | null>;
  findMany(
    input: FindManyDatabaseImplementationInput,
  ): Promise<readonly DatabaseImplementationResult[]>;
}

export interface DatabaseAdapterImplementation<TContext = unknown> {
  create(
    input: CreateDatabaseImplementationInput,
    context?: TContext,
  ): Promise<DatabaseImplementationResult>;
  update(
    input: UpdateBundleDatabaseImplementationInput,
    context?: TContext,
  ): Promise<Partial<BundleRow> | null>;
  delete(
    input: DeleteDatabaseImplementationInput,
    context?: TContext,
  ): Promise<void>;
  count(input: CountBundlesDatabaseInput, context?: TContext): Promise<number>;
  findOne(
    input: FindOneDatabaseImplementationInput,
    context?: TContext,
  ): Promise<Partial<BundleRow> | Partial<ChannelRow> | null>;
  findMany(
    input: FindManyDatabaseImplementationInput,
    context?: TContext,
  ): Promise<readonly DatabaseImplementationResult[]>;
  getUpdateInfo?: (
    args: GetBundlesArgs,
    context?: TContext,
  ) => Promise<UpdateInfo | null>;
  transaction?: <TResult>(
    callback: (
      transaction: TransactionDatabaseAdapterImplementation,
    ) => Promise<TResult>,
    context?: TContext,
  ) => Promise<TResult>;
  onUnmount?: () => Promise<void>;
}

export interface DatabaseAdapterLifecycleHooks {
  readonly onDatabaseUpdated?: () => Promise<void>;
}
