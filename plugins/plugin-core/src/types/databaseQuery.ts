import type { DatabaseField, DatabaseModel, DatabaseRow } from "./databaseRows";

export type DatabaseWhereOperator =
  | "eq"
  | "ne"
  | "lt"
  | "lte"
  | "gt"
  | "gte"
  | "in"
  | "not_in"
  | "contains"
  | "starts_with"
  | "ends_with";

export type DatabaseWhereConnector = "AND" | "OR";
export type DatabaseStringComparisonMode = "sensitive" | "insensitive";

type WhereBase<TField extends string> = {
  readonly field: TField;
  readonly connector?: DatabaseWhereConnector;
};

type EqualityWhere<TField extends string, TValue> = WhereBase<TField> & {
  readonly operator?: "eq" | "ne";
  readonly value: TValue;
};

type StringWhere<TField extends string> = WhereBase<TField> & {
  readonly operator?: "eq" | "ne" | "contains" | "starts_with" | "ends_with";
  readonly value: string;
  readonly mode?: DatabaseStringComparisonMode;
};

type OrderedWhere<
  TField extends string,
  TValue extends number | string,
> = WhereBase<TField> & {
  readonly operator: "gt" | "gte" | "lt" | "lte";
  readonly value: TValue;
};

type SetWhere<
  TField extends string,
  TValue extends boolean | number | string,
> = WhereBase<TField> & {
  readonly operator: "in" | "not_in";
  readonly value: readonly TValue[];
};

type ScalarWhereValue<TValue> = unknown extends TValue
  ? never
  : Extract<TValue, readonly unknown[] | object> extends never
    ? Extract<TValue, boolean | number | string | null>
    : never;

type FieldWhere<TField extends string, TValue> =
  | ([ScalarWhereValue<TValue>] extends [never]
      ? never
      : EqualityWhere<TField, ScalarWhereValue<TValue>>)
  | (Extract<TValue, string> extends never ? never : StringWhere<TField>)
  | (Extract<TValue, number | string> extends never
      ? never
      : OrderedWhere<TField, Extract<TValue, number | string>>)
  | (Extract<TValue, boolean | number | string> extends never
      ? never
      : SetWhere<TField, Extract<TValue, boolean | number | string>>);

export type DatabaseWhere<TModel extends DatabaseModel> = {
  readonly [TField in DatabaseField<TModel>]: FieldWhere<
    TField,
    DatabaseRow<TModel>[TField]
  >;
}[DatabaseField<TModel>];

export type DatabaseSelect<TModel extends DatabaseModel> =
  readonly DatabaseField<TModel>[];

export type SelectedDatabaseRow<
  TModel extends DatabaseModel,
  TSelect extends DatabaseSelect<TModel> | undefined,
> =
  TSelect extends DatabaseSelect<TModel>
    ? Pick<DatabaseRow<TModel>, TSelect[number]>
    : DatabaseRow<TModel>;

type DatabaseSortableField<TModel extends DatabaseModel> = {
  readonly [TField in DatabaseField<TModel>]: Exclude<
    DatabaseRow<TModel>[TField],
    null
  > extends number | string
    ? TField
    : never;
}[DatabaseField<TModel>];

export interface DatabaseSortBy<TModel extends DatabaseModel> {
  readonly field: DatabaseSortableField<TModel>;
  readonly direction: "asc" | "desc";
}
