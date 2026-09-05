import type { DatabaseCommit, DatabaseCommitResult } from "./databasePlugin";
import type {
  DatabaseDistinctFields,
  DatabaseDistinctOn,
  DatabaseOrderBy,
  DatabaseSelect,
  DatabaseWhere,
  SelectedDatabaseRow,
} from "./databaseQuery";
import type {
  BundleRow,
  ApiKeyRow,
  DatabaseModel,
  DatabaseRow,
  InsightsInstallationRow,
  ReleaseCatalogRow,
  ReleaseRow,
} from "./databaseRows";

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
  readonly releases: {
    readonly create: true;
    readonly update: true;
    readonly delete: true;
    readonly count: true;
    readonly findOne: true;
    readonly findMany: true;
  };
  readonly release_catalogs: {
    readonly create: true;
    readonly update: true;
    readonly delete: false;
    readonly count: false;
    readonly findOne: true;
    readonly findMany: true;
  };
  readonly channels: {
    readonly create: true;
    readonly update: false;
    readonly delete: true;
    readonly count: false;
    readonly findOne: true;
    readonly findMany: true;
  };
  readonly bundle_events: {
    readonly create: true;
    readonly update: false;
    readonly delete: false;
    readonly count: true;
    readonly findOne: false;
    readonly findMany: true;
  };
  readonly bundle_installations: {
    readonly create: true;
    readonly update: true;
    readonly delete: false;
    readonly count: true;
    readonly findOne: true;
    readonly findMany: true;
  };
  readonly api_keys: {
    readonly create: true;
    readonly update: true;
    readonly delete: false;
    readonly count: false;
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

type CreateDatabaseInputBase<
  TModel extends CreateDatabaseModel,
  TSelect extends DatabaseSelect<TModel> | undefined = undefined,
> = {
  readonly model: TModel;
  readonly data: DatabaseRow<TModel>;
  readonly select?: TSelect;
};

export type CreateDatabaseInput<
  TModel extends CreateDatabaseModel,
  TSelect extends DatabaseSelect<TModel> | undefined = undefined,
> = CreateDatabaseInputBase<TModel, TSelect> &
  (TModel extends "channels" | "api_keys" | "bundle_installations"
    ? { readonly onConflict?: "ignore" }
    : { readonly onConflict?: never });

type BundleRowUpdateFields = Partial<Omit<BundleRow, "id">>;

export type ReleaseRowUpdate = Partial<
  Pick<
    ReleaseRow,
    | "revision"
    | "scope_key"
    | "target_app_version"
    | "fingerprint_hash"
    | "enabled"
    | "should_force_update"
    | "message"
    | "rollout_cohort_count"
    | "target_cohorts"
    | "updated_at_ms"
  >
>;

export type ReleaseCatalogRowUpdate = Omit<ReleaseCatalogRow, "scope_key">;

export type BundleRowUpdate = BundleRowUpdateFields;
export type ApiKeyRowUpdate = Pick<ApiKeyRow, "revoked_at_ms">;
export type InsightsInstallationRowUpdate = Omit<
  InsightsInstallationRow,
  "install_id"
>;

export type DatabaseRowUpdate<TModel extends UpdateDatabaseModel> = {
  readonly bundles: BundleRowUpdate;
  readonly releases: ReleaseRowUpdate;
  readonly release_catalogs: ReleaseCatalogRowUpdate;
  readonly bundle_installations: InsightsInstallationRowUpdate;
  readonly api_keys: ApiKeyRowUpdate;
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
  readonly distinctOn?: DatabaseDistinctOn<TModel>;
  readonly select?: TSelect;
};

export type SelectedDatabaseInputRow<
  TInput extends {
    readonly model: DatabaseModel;
    readonly select?: readonly string[] | undefined;
  },
> = SelectedDatabaseRow<
  TInput["model"],
  "select" extends keyof TInput
    ? Extract<TInput["select"], DatabaseSelect<TInput["model"]> | undefined>
    : undefined
>;

export interface DatabasePluginCrud {
  create<TInput extends CreateDatabaseImplementationInput>(
    input: TInput,
  ): Promise<SelectedDatabaseInputRow<TInput>>;
  update<TInput extends UpdateDatabaseImplementationInput>(
    input: TInput,
  ): Promise<SelectedDatabaseInputRow<TInput> | null>;
  delete(input: DeleteDatabaseImplementationInput): Promise<void>;
  count(input: CountDatabaseImplementationInput): Promise<number>;
  findOne<TInput extends FindOneDatabaseImplementationInput>(
    input: TInput,
  ): Promise<SelectedDatabaseInputRow<TInput> | null>;
  findMany<TInput extends FindManyDatabasePluginInput>(
    input: TInput,
  ): Promise<SelectedDatabaseInputRow<TInput>[]>;
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

export type FindManyDatabasePluginInput = {
  readonly [TModel in FindManyDatabaseModel]: FindManyDatabaseInput<
    TModel,
    DatabaseSelect<TModel> | undefined
  >;
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
  /** Native atomic event insert and monotonic installation update. */
  recordInsights(
    input: import("./databasePlugin").InsightsRecordInput,
  ): Promise<void>;
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
  insertChannel(
    input: import("./databasePlugin").ChannelInsertInput,
  ): Promise<import("./databasePlugin").ChannelInsertResult>;
  deleteChannel(
    input: import("./databasePlugin").ChannelDeleteInput,
  ): Promise<import("./databasePlugin").ChannelDeleteResult>;
  transaction?: <TResult>(
    callback: (
      transaction: TransactionDatabasePluginImplementation,
    ) => Promise<TResult>,
  ) => Promise<TResult>;
  commit?: (input: DatabaseCommit) => Promise<DatabaseCommitResult>;
  dispose?: () => Promise<void>;
}
