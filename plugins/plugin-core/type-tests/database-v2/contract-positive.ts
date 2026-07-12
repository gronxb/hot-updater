import {
  DatabaseConnectorErrorV2,
  type AssertedDatabaseScope,
  type BundleChangeSetV2,
  type CommitReceiptV2,
  type DatabaseConnectorV2,
} from "@hot-updater/plugin-core/database-v2";

type AuthContext = {
  readonly authenticated: true;
};

declare const connector: DatabaseConnectorV2<AuthContext>;
declare const changeSet: BundleChangeSetV2;
declare const receipt: CommitReceiptV2;

const scope: AssertedDatabaseScope<AuthContext> = {
  tenantId: "tenant-a",
  principalId: "principal-a",
  context: { authenticated: true },
};

const error = new DatabaseConnectorErrorV2("INVALID_SCOPE", "scope is invalid");

void connector;
void changeSet;
void receipt;
void scope;
void error;
