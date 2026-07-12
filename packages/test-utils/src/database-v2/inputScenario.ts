import {
  assertDatabaseConnectorV2,
  assertDatabaseConnectorV2Error,
} from "./assertions";
import {
  DATABASE_V2_BUNDLE_IDS,
  DATABASE_V2_CHANGE_SET_IDS,
  DATABASE_V2_SCOPE_ALPHA,
  createDatabaseV2TestBundle,
} from "./fixtures";
import type {
  DatabaseConnectorV2TestChangeSet,
  DatabaseConnectorV2TestHarness,
} from "./types";

export async function runDatabaseV2MalformedChangeSetScenario(
  harness: DatabaseConnectorV2TestHarness,
): Promise<void> {
  const subject = await harness.createSubject("malformed-change-set");
  const connection = await subject.connector.connect();
  const session = await connection.openSession(DATABASE_V2_SCOPE_ALPHA);
  const bundle = createDatabaseV2TestBundle(
    DATABASE_V2_BUNDLE_IDS.first,
    "production",
  );
  const beforeAttempts = subject.instrumentation.backendCommitAttempts();
  const invalidChangeSets: readonly DatabaseConnectorV2TestChangeSet[] = [
    {
      id: "not-a-change-set-id",
      changes: [
        {
          type: "put",
          value: bundle,
          precondition: { state: "absent" },
        },
      ],
    },
    { id: DATABASE_V2_CHANGE_SET_IDS.malformed, changes: [] },
    {
      id: DATABASE_V2_CHANGE_SET_IDS.malformed,
      changes: [
        { type: "put", value: bundle, precondition: { state: "absent" } },
        { type: "put", value: bundle, precondition: { state: "absent" } },
      ],
    },
    {
      id: DATABASE_V2_CHANGE_SET_IDS.malformed,
      changes: [
        {
          type: "put",
          value: bundle,
          precondition: { state: "revision", revision: "" },
        },
      ],
    },
  ];

  for (const changeSet of invalidChangeSets) {
    await assertDatabaseConnectorV2Error(
      () => session.applyChangeSet(changeSet),
      "INVALID_CHANGE_SET",
      "malformed-input",
    );
  }
  assertDatabaseConnectorV2(
    subject.instrumentation.backendCommitAttempts() === beforeAttempts,
    "malformed-input",
    "malformed change sets must fail before backend I/O",
  );
}
