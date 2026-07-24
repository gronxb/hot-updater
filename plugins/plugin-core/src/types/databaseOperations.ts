import type { GetBundlesArgs, UpdateInfo } from "@hot-updater/core";

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
