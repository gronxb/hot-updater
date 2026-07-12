import {
  assertDatabaseConnectorV2,
  assertDatabaseConnectorV2Error,
} from "./assertions";
import {
  DATABASE_V2_BUNDLE_IDS,
  DATABASE_V2_CHANGE_SET_IDS,
  DATABASE_V2_SCOPE_ALPHA,
  DATABASE_V2_SCOPE_BETA,
  DATABASE_V2_SCOPE_OTHER_TENANT,
  createDatabaseV2PutChangeSet,
  createDatabaseV2TestBundle,
} from "./fixtures";
import type { DatabaseConnectorV2TestHarness } from "./types";

export async function runDatabaseV2HappyReadAndScopeScenario(
  harness: DatabaseConnectorV2TestHarness,
): Promise<void> {
  const subject = await harness.createSubject("happy-read-and-scope");
  const connection = await subject.connector.connect();
  const alpha = await connection.openSession(DATABASE_V2_SCOPE_ALPHA);
  const first = createDatabaseV2TestBundle(
    DATABASE_V2_BUNDLE_IDS.first,
    "production",
  );
  const second = createDatabaseV2TestBundle(
    DATABASE_V2_BUNDLE_IDS.second,
    "staging",
  );

  const receipt = await alpha.applyChangeSet(
    createDatabaseV2PutChangeSet(DATABASE_V2_CHANGE_SET_IDS.seed, [
      first,
      second,
    ]),
  );
  assertDatabaseConnectorV2(
    receipt.outcome === "committed",
    "happy-read",
    "the seed change set must commit",
  );

  const found = await alpha.bundles.get(first.id);
  assertDatabaseConnectorV2(
    found?.value.id === first.id && found.revision.length > 0,
    "happy-read",
    "get must return the bundle with an opaque non-empty revision",
  );
  const page = await alpha.bundles.page({ limit: 10 });
  assertDatabaseConnectorV2(
    page.data.length === 2 && page.pagination.total === 2,
    "happy-read",
    "page must return all tenant rows and the full filtered total",
  );
  const channels = await alpha.bundles.channels();
  assertDatabaseConnectorV2(
    channels.includes("production") && channels.includes("staging"),
    "happy-read",
    "channels must expose the tenant's distinct channels",
  );

  const beta = await connection.openSession(DATABASE_V2_SCOPE_BETA);
  const shared = await beta.bundles.get(first.id);
  assertDatabaseConnectorV2(
    shared?.value.id === first.id,
    "scope-isolation",
    "another asserted principal in the same tenant must see tenant rows",
  );

  const otherTenant = await connection.openSession(
    DATABASE_V2_SCOPE_OTHER_TENANT,
  );
  const isolated = await otherTenant.bundles.page({ limit: 10 });
  assertDatabaseConnectorV2(
    isolated.data.length === 0 && isolated.pagination.total === 0,
    "scope-isolation",
    "another tenant must not observe tenant rows",
  );

  const spoofed = await connection.openSession({
    tenantId: "tenant-other",
    principalId: "principal-spoof",
    context: {
      marker: "spoof",
      tenantId: DATABASE_V2_SCOPE_ALPHA.tenantId,
      principalId: DATABASE_V2_SCOPE_ALPHA.principalId,
    },
  });
  const spoofBundle = createDatabaseV2TestBundle(
    DATABASE_V2_BUNDLE_IDS.third,
    "spoof-check",
  );
  await spoofed.applyChangeSet(
    createDatabaseV2PutChangeSet("10000000-0000-4000-8000-000000000007", [
      spoofBundle,
    ]),
  );
  assertDatabaseConnectorV2(
    (await alpha.bundles.get(spoofBundle.id)) === null,
    "scope-isolation",
    "opaque context must not override asserted tenant or principal identifiers",
  );

  const beforeInvalidTenant =
    subject.instrumentation.backendOperationAttempts();
  await assertDatabaseConnectorV2Error(
    () =>
      connection.openSession({
        tenantId: "",
        principalId: DATABASE_V2_SCOPE_ALPHA.principalId,
        context: { marker: "invalid" },
      }),
    "INVALID_SCOPE",
    "malformed-input",
  );
  assertDatabaseConnectorV2(
    subject.instrumentation.backendOperationAttempts() === beforeInvalidTenant,
    "scope-zero-io",
    "an empty tenant must fail before any observable backend I/O",
  );
  const beforeInvalidPrincipal =
    subject.instrumentation.backendOperationAttempts();
  await assertDatabaseConnectorV2Error(
    () =>
      connection.openSession({
        tenantId: DATABASE_V2_SCOPE_ALPHA.tenantId,
        principalId: "",
        context: { marker: "invalid" },
      }),
    "INVALID_SCOPE",
    "malformed-input",
  );
  assertDatabaseConnectorV2(
    subject.instrumentation.backendOperationAttempts() ===
      beforeInvalidPrincipal,
    "scope-zero-io",
    "an empty principal must fail before any observable backend I/O",
  );
}

export async function runDatabaseV2CursorBindingScenario(
  harness: DatabaseConnectorV2TestHarness,
): Promise<void> {
  const subject = await harness.createSubject("cursor-binding");
  const connection = await subject.connector.connect();
  const alpha = await connection.openSession(DATABASE_V2_SCOPE_ALPHA);
  const bundles = [
    createDatabaseV2TestBundle(DATABASE_V2_BUNDLE_IDS.first, "production"),
    createDatabaseV2TestBundle(DATABASE_V2_BUNDLE_IDS.second, "production"),
    createDatabaseV2TestBundle(DATABASE_V2_BUNDLE_IDS.third, "production"),
  ];
  await alpha.applyChangeSet(
    createDatabaseV2PutChangeSet(DATABASE_V2_CHANGE_SET_IDS.seed, bundles),
  );

  const query = {
    limit: 1,
    orderBy: { field: "id", direction: "asc" },
  } as const;
  const firstPage = await alpha.bundles.page(query);
  const cursor = firstPage.pagination.nextCursor;
  assertDatabaseConnectorV2(
    cursor !== null && firstPage.data.length === 1,
    "cursor-binding",
    "the first page must expose one returned navigation cursor",
  );
  const nextPage = await alpha.bundles.page({
    ...query,
    cursor: { after: cursor },
  });
  assertDatabaseConnectorV2(
    nextPage.data[0]?.value.id === DATABASE_V2_BUNDLE_IDS.second,
    "cursor-binding",
    "a valid after cursor must advance in the requested order",
  );

  const beta = await connection.openSession(DATABASE_V2_SCOPE_BETA);
  await assertDatabaseConnectorV2Error(
    () => beta.bundles.page({ ...query, cursor: { after: cursor } }),
    "INVALID_CURSOR",
    "cursor-binding",
  );
  await assertDatabaseConnectorV2Error(
    () => alpha.bundles.page({ limit: 2, cursor: { after: cursor } }),
    "INVALID_CURSOR",
    "cursor-binding",
  );
  await assertDatabaseConnectorV2Error(
    () => alpha.bundles.page({ limit: 1, cursor: { after: "tampered" } }),
    "INVALID_CURSOR",
    "malformed-input",
  );
}
