import type {
  DatabaseConnectionResourceV2,
  DatabaseConnectionRuntimeV2Options,
} from "./backend";
import {
  addSetValueV2,
  createSetV2,
  deleteSetValueV2,
  setValuesV2,
} from "./collectionIntrinsics";
import type { AssertedDatabaseScope } from "./common";
import type { DatabaseConnectionV2, DatabaseSessionV2 } from "./connector";
import { hashDatabaseScopeV1 } from "./databaseIdentity";
import { DatabaseSessionRuntimeV2 } from "./databaseSessionRuntime";
import { DatabaseConnectorErrorV2 } from "./errors";
import { captureDatabaseScopeV2 } from "./scopeValidation";

type DatabaseConnectionStateV2 = "open" | "closing" | "closed";

class DatabaseConnectionRuntimeV2<
  TContext,
> implements DatabaseConnectionV2<TContext> {
  private state: DatabaseConnectionStateV2 = "open";
  private closeCompletion: Promise<void> | null = null;
  private readonly sessions = createSetV2<DatabaseSessionRuntimeV2>();

  constructor(private readonly options: DatabaseConnectionRuntimeV2Options) {}

  async openSession(
    assertedScope: AssertedDatabaseScope<TContext>,
  ): Promise<DatabaseSessionV2> {
    this.assertOpen();
    const captured = captureDatabaseScopeV2(assertedScope);
    const scopeId = await hashDatabaseScopeV1(captured, this.options.sha256);
    this.assertOpen();
    const session = new DatabaseSessionRuntimeV2({
      backend: this.options.backend,
      scope: Object.freeze({
        tenantId: captured.tenantId,
        principalId: captured.principalId,
        scopeId,
      }),
      ...(this.options.sha256 === undefined
        ? {}
        : { sha256: this.options.sha256 }),
      onClosed: (closed) => {
        deleteSetValueV2(this.sessions, closed);
      },
    });
    addSetValueV2(this.sessions, session);
    return session;
  }

  close(): Promise<void> {
    if (this.closeCompletion !== null) {
      return this.closeCompletion;
    }
    if (this.state === "closed") {
      return Promise.resolve();
    }
    this.state = "closing";
    this.closeCompletion = this.closeAll();
    return this.closeCompletion;
  }

  private async closeAll(): Promise<void> {
    await Promise.all(
      setValuesV2(this.sessions).map(async (session) => session.close()),
    );
    try {
      await disposeResource(this.options.resource);
    } finally {
      this.state = "closed";
    }
  }

  private assertOpen(): void {
    switch (this.state) {
      case "open":
        return;
      case "closing":
        throw new DatabaseConnectorErrorV2(
          "CONNECTION_CLOSING",
          "connection is closing",
        );
      case "closed":
        throw new DatabaseConnectorErrorV2(
          "CONNECTION_CLOSED",
          "connection is closed",
        );
    }
  }
}

const disposeResource = async (
  resource: DatabaseConnectionResourceV2,
): Promise<void> => {
  switch (resource.ownership) {
    case "borrowed":
      return;
    case "owned":
      await resource.dispose();
  }
};

export const createDatabaseConnectionRuntimeV2 = <TContext>(
  options: DatabaseConnectionRuntimeV2Options,
): DatabaseConnectionV2<TContext> =>
  new DatabaseConnectionRuntimeV2<TContext>(options);
