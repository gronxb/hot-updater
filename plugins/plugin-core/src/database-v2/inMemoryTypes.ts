import type { Bundle } from "@hot-updater/core";

import type { BundleWhereV2 } from "./bundles";

export interface InMemoryStoredBundleV2 {
  readonly value: Bundle;
  readonly revision: string;
}

export interface InMemoryCursorQueryV2 {
  readonly where?: BundleWhereV2;
  readonly limit: number;
  readonly direction: "asc" | "desc";
}

export interface InMemoryCursorRequestV2 {
  readonly direction: "after" | "before";
  readonly token: string;
}

export interface InMemoryPageRequestV2 {
  readonly query: InMemoryCursorQueryV2;
  readonly cursor: InMemoryCursorRequestV2 | null;
  readonly identity: string;
}

export interface InMemoryCursorRecordV2 {
  readonly tenantId: string;
  readonly principalId: string;
  readonly queryIdentity: string;
  readonly direction: "after" | "before";
  readonly anchorId: string;
}
