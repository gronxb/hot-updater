import type { Bundle, Platform } from "@hot-updater/core";

import type { Versioned } from "./common";

export interface BundleWhereV2 {
  readonly channel?: string;
  readonly platform?: Platform;
  readonly enabled?: boolean;
  readonly id?: {
    readonly eq?: string;
    readonly gt?: string;
    readonly gte?: string;
    readonly lt?: string;
    readonly lte?: string;
    readonly in?: readonly string[];
  };
  readonly targetAppVersion?: string | null;
  readonly targetAppVersionIn?: readonly string[];
  readonly targetAppVersionNotNull?: boolean;
  readonly fingerprintHash?: string | null;
}

export interface BundlePageQueryV2 {
  readonly where?: BundleWhereV2;
  readonly limit: number;
  readonly cursor?:
    | { readonly after: string; readonly before?: never }
    | { readonly before: string; readonly after?: never };
  readonly orderBy?: {
    readonly field: "id";
    readonly direction: "asc" | "desc";
  };
}

export interface BundlePageV2 {
  readonly data: readonly Versioned<Bundle>[];
  readonly pagination: {
    readonly total: number;
    readonly hasNextPage: boolean;
    readonly hasPreviousPage: boolean;
    readonly nextCursor: string | null;
    readonly previousCursor: string | null;
  };
}

export interface BundleRepositoryV2 {
  get(id: string): Promise<Versioned<Bundle> | null>;
  page(query: BundlePageQueryV2): Promise<BundlePageV2>;
  channels(): Promise<readonly string[]>;
}

export type BundleChangeV2 =
  | {
      readonly type: "put";
      readonly value: Bundle;
      readonly precondition:
        | { readonly state: "absent" }
        | { readonly state: "revision"; readonly revision: string };
    }
  | {
      readonly type: "delete";
      readonly id: string;
      readonly precondition: {
        readonly state: "revision";
        readonly revision: string;
      };
    };

export interface BundleChangeSetV2 {
  readonly id: string;
  readonly changes: readonly BundleChangeV2[];
}
