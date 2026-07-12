import {
  createInMemoryDatabaseConnectorV2,
  DatabaseConnectorErrorV2,
} from "@hot-updater/plugin-core/database-v2";

const ensure = (condition, message) => {
  if (!condition) {
    throw new Error(message);
  }
};

const expectCode = async (code, operation) => {
  try {
    await operation();
  } catch (error) {
    ensure(error instanceof DatabaseConnectorErrorV2, `expected ${code} error`);
    ensure(error.code === code, `expected ${code}, received ${error.code}`);
    return;
  }
  throw new Error(`expected ${code} to reject`);
};

const createBundle = (id, channel) => ({
  id,
  platform: "ios",
  shouldForceUpdate: false,
  enabled: true,
  fileHash: `hash-${id}`,
  storageUri: `memory://${id}`,
  gitCommitHash: null,
  message: `bundle-${id}`,
  channel,
  targetAppVersion: "1.0.0",
  fingerprintHash: null,
  metadata: { app_version: "1.0.0" },
});

const connector = createInMemoryDatabaseConnectorV2();
const connection = await connector.connect();
const scope = {
  tenantId: "sdk-tenant-a",
  principalId: "sdk-principal-a",
  context: { source: "checked-in-driver" },
};

await expectCode("INVALID_SCOPE", () =>
  connection.openSession({ ...scope, tenantId: "" }),
);

const session = await connection.openSession(scope);
const firstBundle = createBundle(
  "018f12ab-1234-7abc-8def-000000000101",
  "production",
);
const secondBundle = createBundle(
  "018f12ab-1234-7abc-8def-000000000102",
  "staging",
);
const atomicChangeSet = {
  id: "10000000-0000-4000-8000-000000000601",
  changes: [firstBundle, secondBundle].map((value) => ({
    type: "put",
    value,
    precondition: { state: "absent" },
  })),
};

const committed = await session.applyChangeSet(atomicChangeSet);
ensure(committed.outcome === "committed", "atomic change set did not commit");
ensure(
  Object.keys(committed.revisions).length === 2,
  "atomic receipt did not include two revisions",
);
ensure(
  (await session.bundles.get(firstBundle.id))?.value.channel === "production",
  "bundle read did not return the committed value",
);

const firstPage = await session.bundles.page({ limit: 1 });
ensure(firstPage.data.length === 1, "first page did not contain one bundle");
ensure(
  firstPage.pagination.total === 2,
  "page total did not include both rows",
);
ensure(
  firstPage.pagination.nextCursor !== null,
  "first page lacked next cursor",
);

const cursorSuffix = firstPage.pagination.nextCursor.endsWith("x") ? "y" : "x";
const corruptedCursor = `${firstPage.pagination.nextCursor.slice(0, -1)}${cursorSuffix}`;
await expectCode("INVALID_CURSOR", () =>
  session.bundles.page({ limit: 1, cursor: { after: corruptedCursor } }),
);

const principalSession = await connection.openSession({
  ...scope,
  principalId: "sdk-principal-b",
});
await expectCode("INVALID_CURSOR", () =>
  principalSession.bundles.page({
    limit: 1,
    cursor: { after: firstPage.pagination.nextCursor },
  }),
);
ensure(
  (await principalSession.bundles.get(firstBundle.id))?.value.id ===
    firstBundle.id,
  "same-tenant principal could not read tenant data",
);

const isolatedSession = await connection.openSession({
  ...scope,
  tenantId: "sdk-tenant-b",
});
ensure(
  (await isolatedSession.bundles.page({ limit: 10 })).data.length === 0,
  "other tenant observed committed rows",
);

await session.close();
const replaySession = await connection.openSession(scope);
const replayed = await replaySession.applyChangeSet(atomicChangeSet);
ensure(replayed.outcome === "replayed", "fresh-session retry did not replay");
ensure(
  JSON.stringify(replayed.revisions) === JSON.stringify(committed.revisions),
  "replay did not preserve committed revisions",
);

const conflicting = await replaySession.applyChangeSet({
  ...atomicChangeSet,
  changes: [
    {
      type: "put",
      value: { ...firstBundle, channel: "conflicting" },
      precondition: { state: "absent" },
    },
  ],
});
ensure(
  conflicting.outcome === "rejected" && conflicting.reason === "conflict",
  "same-id different-payload replay was not a typed conflict receipt",
);

await Promise.all([
  replaySession.close(),
  principalSession.close(),
  isolatedSession.close(),
]);
await expectCode("SESSION_CLOSED", () =>
  replaySession.bundles.page({ limit: 1 }),
);
await connection.close();
await expectCode("CONNECTION_CLOSED", () => connection.openSession(scope));

console.log(
  JSON.stringify({
    databaseV2SdkDriver: "passed",
    committed: committed.outcome,
    replayed: replayed.outcome,
    conflicting: conflicting.outcome,
    tenantIsolation: true,
    principalCursorIsolation: true,
    lifecycle: "closed",
  }),
);
