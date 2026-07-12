import type { AssertedDatabaseScope } from "@hot-updater/plugin-core/database-v2";

type OptionalScope = {
  readonly tenantId?: string;
  readonly principalId?: string;
  readonly context: unknown;
};

declare const optionalScope: OptionalScope;
const scope: AssertedDatabaseScope<unknown> = optionalScope;

void scope;
