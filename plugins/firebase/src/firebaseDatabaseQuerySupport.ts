import type {
  DatabaseWhereOperator,
  FindManyDatabaseImplementationInput,
} from "@hot-updater/plugin-core";
import type { WhereFilterOp } from "firebase-admin/firestore";

export type FirebaseBundleEventsFindManyInput = Extract<
  FindManyDatabaseImplementationInput,
  { readonly model: "bundle_events" }
>;

const FIREBASE_WHERE_OPERATORS: Partial<
  Record<DatabaseWhereOperator, WhereFilterOp>
> = {
  eq: "==",
  ne: "!=",
  lt: "<",
  lte: "<=",
  gt: ">",
  gte: ">=",
  in: "in",
  not_in: "not-in",
};

export const getFirebaseWhereOperator = (
  operator: DatabaseWhereOperator,
): WhereFilterOp | undefined => FIREBASE_WHERE_OPERATORS[operator];

export const supportsFirebaseBundleEventQuery = (
  input: FirebaseBundleEventsFindManyInput,
): boolean => {
  if (input.distinctOn !== undefined) return false;
  const orderBy = input.orderBy ?? (input.sortBy ? [input.sortBy] : []);
  if (orderBy.some((clause) => clause.nulls !== undefined)) return false;
  return (input.where ?? []).every((condition) => {
    if (condition.connector === "OR") return false;
    if ("mode" in condition && condition.mode === "insensitive") return false;
    const operator = condition.operator ?? "eq";
    return FIREBASE_WHERE_OPERATORS[operator] !== undefined;
  });
};
