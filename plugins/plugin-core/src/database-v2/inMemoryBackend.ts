import type { Bundle } from "@hot-updater/core";

import type {
  DatabaseBackendCommitRequestV2,
  DatabaseBackendScopeV2,
  DatabaseBackendV2,
} from "./backend";
import type { BundlePageQueryV2, BundlePageV2 } from "./bundles";
import {
  addSetValueV2,
  createMapV2,
  createSetV2,
  getMapValueV2,
  mapValuesV2,
  setValuesV2,
} from "./collectionIntrinsics";
import type { Sha256Digest, Versioned } from "./common";
import { hashDatabaseScopeV1 } from "./databaseIdentity";
import { DatabaseConnectorErrorV2 } from "./errors";
import { cloneInMemoryVersionedBundleV2 } from "./inMemoryClone";
import {
  commitInMemoryChangeSetV2,
  type InMemoryCommitStateV2,
} from "./inMemoryCommit";
import { InMemoryCursorRegistryV2 } from "./inMemoryCursor";
import { InMemoryCommitLockV2 } from "./inMemoryLock";
import { paginateInMemoryBundlesV2 } from "./inMemoryPagination";
import { parseInMemoryPageQueryV2 } from "./inMemoryQuery";
import type { CommitReceiptV2 } from "./receipts";

interface InMemoryDatabaseBackendV2Options {
  readonly sha256?: Sha256Digest;
}

export class InMemoryDatabaseBackendV2 implements DatabaseBackendV2 {
  private readonly state: InMemoryCommitStateV2 = {
    receipts: createMapV2(),
    rowsByTenant: createMapV2(),
    nextRevision: 0,
  };
  private readonly cursors = new InMemoryCursorRegistryV2();
  private readonly commitLock = new InMemoryCommitLockV2();
  private readonly sha256: Sha256Digest | undefined;

  constructor(options: InMemoryDatabaseBackendV2Options = {}) {
    this.sha256 = options.sha256;
  }

  async get(
    scope: DatabaseBackendScopeV2,
    id: string,
  ): Promise<Versioned<Bundle> | null> {
    await this.assertScopeIntegrity(scope);
    const tenantRows = getMapValueV2(this.state.rowsByTenant, scope.tenantId);
    const row =
      tenantRows === undefined ? undefined : getMapValueV2(tenantRows, id);
    return row === undefined ? null : cloneInMemoryVersionedBundleV2(row);
  }

  async page(
    scope: DatabaseBackendScopeV2,
    query: BundlePageQueryV2,
  ): Promise<BundlePageV2> {
    await this.assertScopeIntegrity(scope);
    const request = parseInMemoryPageQueryV2(query);
    const tenantRows = getMapValueV2(this.state.rowsByTenant, scope.tenantId);
    const rows = tenantRows === undefined ? [] : mapValuesV2(tenantRows);
    return paginateInMemoryBundlesV2({
      scope,
      request,
      rows,
      cursors: this.cursors,
    });
  }

  async channels(scope: DatabaseBackendScopeV2): Promise<readonly string[]> {
    await this.assertScopeIntegrity(scope);
    const tenantRows = getMapValueV2(this.state.rowsByTenant, scope.tenantId);
    const channels = createSetV2<string>();
    for (const row of tenantRows === undefined ? [] : mapValuesV2(tenantRows)) {
      addSetValueV2(channels, row.value.channel);
    }
    return Object.freeze([...setValuesV2(channels)].sort());
  }

  async commit(request: DatabaseBackendCommitRequestV2): Promise<unknown> {
    await this.assertScopeIntegrity(request.scope);
    return await this.commitLock.run(
      async (): Promise<CommitReceiptV2> =>
        commitInMemoryChangeSetV2(request, this.state),
    );
  }

  private async assertScopeIntegrity(
    scope: DatabaseBackendScopeV2,
  ): Promise<void> {
    const expected = await hashDatabaseScopeV1(scope, this.sha256);
    if (expected !== scope.scopeId) {
      throw new DatabaseConnectorErrorV2(
        "CONNECTOR_PROTOCOL_VIOLATION",
        "backend scope identity does not match its asserted identifiers",
      );
    }
  }
}

export const createInMemoryDatabaseBackendV2 = (
  options: InMemoryDatabaseBackendV2Options = {},
): DatabaseBackendV2 => new InMemoryDatabaseBackendV2(options);
