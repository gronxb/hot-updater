import type { GetBundlesArgs, UpdateInfo } from "@hot-updater/core";

import {
  databaseBundleEventService,
  databaseAnalyticsSupport,
  type DatabaseBundleEventService,
} from "./databaseBundleEvents";
import type {
  DatabaseDistinctFields,
  DatabaseDistinctOn,
  DatabaseOrderBy,
  DatabaseSelect,
  DatabaseSortBy,
  DatabaseWhere,
  SelectedDatabaseRow,
} from "./databaseQuery";
import type { BundleRow, DatabaseModel, DatabaseRow } from "./databaseRows";

export type DatabaseCapability =
  | "create"
  | "update"
  | "delete"
  | "count"
  | "findOne"
  | "findMany";

export type DatabaseModelCapabilities = {
  readonly bundles: {
    readonly create: true;
    readonly update: true;
    readonly delete: true;
    readonly count: true;
    readonly findOne: true;
    readonly findMany: true;
  };
  readonly bundle_patches: {
    readonly create: true;
    readonly update: false;
    readonly delete: true;
    readonly count: true;
    readonly findOne: true;
    readonly findMany: true;
  };
  readonly bundle_events: {
    readonly create: true;
    readonly update: false;
    readonly delete: false;
    readonly count: true;
    readonly findOne: true;
    readonly findMany: true;
  };
};

export type DatabaseModelsWithCapability<
  TCapability extends DatabaseCapability,
> = {
  readonly [TModel in DatabaseModel]: DatabaseModelCapabilities[TModel][TCapability] extends true
    ? TModel
    : never;
}[DatabaseModel];

export type CreateDatabaseModel = DatabaseModelsWithCapability<"create">;
export type UpdateDatabaseModel = DatabaseModelsWithCapability<"update">;
export type DeleteDatabaseModel = DatabaseModelsWithCapability<"delete">;
export type CountDatabaseModel = DatabaseModelsWithCapability<"count">;
export type FindOneDatabaseModel = DatabaseModelsWithCapability<"findOne">;
export type FindManyDatabaseModel = DatabaseModelsWithCapability<"findMany">;
export type DatabaseDeleteModel = DeleteDatabaseModel;
export type DatabaseFindOneModel = FindOneDatabaseModel;

export type CreateDatabaseInput<
  TModel extends CreateDatabaseModel,
  TSelect extends DatabaseSelect<TModel> | undefined = undefined,
> = {
  readonly model: TModel;
  readonly data: DatabaseRow<TModel>;
  readonly select?: TSelect;
};

export type BundleRowUpdate = Partial<Omit<BundleRow, "id">>;

export type DatabaseRowUpdate<TModel extends UpdateDatabaseModel> = {
  readonly bundles: BundleRowUpdate;
}[TModel];

export type UpdateDatabaseInput<
  TModel extends UpdateDatabaseModel,
  TSelect extends DatabaseSelect<TModel> | undefined = undefined,
> = {
  readonly model: TModel;
  readonly where: readonly DatabaseWhere<TModel>[];
  readonly update: DatabaseRowUpdate<TModel>;
  readonly select?: TSelect;
};
export type UpdateBundleDatabaseInput<
  TSelect extends DatabaseSelect<"bundles"> | undefined = undefined,
> = UpdateDatabaseInput<"bundles", TSelect>;

export type DeleteDatabaseInput<TModel extends DeleteDatabaseModel> = {
  readonly model: TModel;
  readonly where: readonly DatabaseWhere<TModel>[];
};

export type CountDatabaseInput<TModel extends CountDatabaseModel> = {
  readonly model: TModel;
  readonly where?: readonly DatabaseWhere<TModel>[];
  readonly distinct?: DatabaseDistinctFields<TModel>;
};
export type CountBundlesDatabaseInput = CountDatabaseInput<"bundles">;

export type FindOneDatabaseInput<
  TModel extends FindOneDatabaseModel,
  TSelect extends DatabaseSelect<TModel> | undefined = undefined,
> = {
  readonly model: TModel;
  readonly where?: readonly DatabaseWhere<TModel>[];
  readonly select?: TSelect;
};

export type FindManyDatabaseInput<
  TModel extends FindManyDatabaseModel,
  TSelect extends DatabaseSelect<TModel> | undefined = undefined,
> = {
  readonly model: TModel;
  readonly where?: readonly DatabaseWhere<TModel>[];
  readonly limit?: number;
  readonly offset?: number;
  readonly orderBy?: DatabaseOrderBy<TModel>;
  readonly sortBy?: DatabaseSortBy<TModel>;
  readonly distinctOn?: DatabaseDistinctOn<TModel>;
  readonly select?: TSelect;
};

export interface TransactionDatabasePlugin {
  create<
    TModel extends CreateDatabaseModel,
    TSelect extends DatabaseSelect<TModel> | undefined = undefined,
  >(
    input: CreateDatabaseInput<TModel, TSelect>,
  ): Promise<SelectedDatabaseRow<TModel, TSelect>>;
  update<
    TModel extends UpdateDatabaseModel,
    TSelect extends DatabaseSelect<TModel> | undefined = undefined,
  >(
    input: UpdateDatabaseInput<TModel, TSelect>,
  ): Promise<SelectedDatabaseRow<TModel, TSelect> | null>;
  delete<TModel extends DeleteDatabaseModel>(
    input: DeleteDatabaseInput<TModel>,
  ): Promise<void>;
  count<TModel extends CountDatabaseModel>(
    input: CountDatabaseInput<TModel>,
  ): Promise<number>;
  findOne<
    TModel extends FindOneDatabaseModel,
    TSelect extends DatabaseSelect<TModel> | undefined = undefined,
  >(
    input: FindOneDatabaseInput<TModel, TSelect>,
  ): Promise<SelectedDatabaseRow<TModel, TSelect> | null>;
  findMany<
    TModel extends FindManyDatabaseModel,
    TSelect extends DatabaseSelect<TModel> | undefined = undefined,
  >(
    input: FindManyDatabaseInput<TModel, TSelect>,
  ): Promise<SelectedDatabaseRow<TModel, TSelect>[]>;
}

export interface DatabasePlugin {
  readonly name: string;
  readonly [databaseBundleEventService]?: DatabaseBundleEventService;
  readonly [databaseAnalyticsSupport]?: true;
  create<
    TModel extends CreateDatabaseModel,
    TSelect extends DatabaseSelect<TModel> | undefined = undefined,
  >(
    input: CreateDatabaseInput<TModel, TSelect>,
  ): Promise<SelectedDatabaseRow<TModel, TSelect>>;
  update<
    TModel extends UpdateDatabaseModel,
    TSelect extends DatabaseSelect<TModel> | undefined = undefined,
  >(
    input: UpdateDatabaseInput<TModel, TSelect>,
  ): Promise<SelectedDatabaseRow<TModel, TSelect> | null>;
  delete<TModel extends DeleteDatabaseModel>(
    input: DeleteDatabaseInput<TModel>,
  ): Promise<void>;
  count<TModel extends CountDatabaseModel>(
    input: CountDatabaseInput<TModel>,
  ): Promise<number>;
  findOne<
    TModel extends FindOneDatabaseModel,
    TSelect extends DatabaseSelect<TModel> | undefined = undefined,
  >(
    input: FindOneDatabaseInput<TModel, TSelect>,
  ): Promise<SelectedDatabaseRow<TModel, TSelect> | null>;
  findMany<
    TModel extends FindManyDatabaseModel,
    TSelect extends DatabaseSelect<TModel> | undefined = undefined,
  >(
    input: FindManyDatabaseInput<TModel, TSelect>,
  ): Promise<SelectedDatabaseRow<TModel, TSelect>[]>;
  getChannels?: () => Promise<string[]>;
  getUpdateInfo?: (args: GetBundlesArgs) => Promise<UpdateInfo | null>;
  transaction?: <TResult>(
    callback: (transaction: TransactionDatabasePlugin) => Promise<TResult>,
  ) => Promise<TResult>;
  onDatabaseUpdated?: () => Promise<void>;
  onUnmount?: () => Promise<void>;
}

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
