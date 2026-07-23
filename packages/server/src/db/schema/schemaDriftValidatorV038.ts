import type { HotUpdaterVersionedSchema } from "../../schema/types";
import { v0_37_0 } from "../../schema/v0_37_0";
import { v0_38_0 } from "../../schema/v0_38_0";
import { assertSameSchemaValue } from "./schemaDriftValidator";

const dataTables = (schema: HotUpdaterVersionedSchema) =>
  schema.tables.filter((table) => !table.internal);

export const assertV038MigrationSchemaDriftIsAllowlisted = (
  previous: HotUpdaterVersionedSchema,
  next: HotUpdaterVersionedSchema,
): void => {
  assertSameSchemaValue("0.37.0", dataTables(v0_37_0), dataTables(previous));
  assertSameSchemaValue("0.38.0", dataTables(v0_38_0), dataTables(next));
};
