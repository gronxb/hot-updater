export type PersistedUpdateStrategy = "fingerprint" | "appVersion";

export type NotifyAppReadyResult =
  | { readonly status: "UNCHANGED" }
  | {
      readonly fromBundleId: string;
      readonly status: "UPDATE_APPLIED";
      readonly toBundleId: string;
      readonly updateStrategy?: PersistedUpdateStrategy;
    }
  | {
      readonly fromBundleId: string;
      readonly status: "RECOVERED";
      readonly toBundleId: string;
      readonly updateStrategy?: PersistedUpdateStrategy;
    };

export type ResolverNotifyAppReadyResult =
  | { readonly status: "STABLE" }
  | {
      readonly crashedBundleId?: string;
      readonly status: "RECOVERED";
    };

export type ResolverNotifyAppReadyParams = ResolverNotifyAppReadyResult & {
  readonly requestHeaders?: Record<string, string>;
  readonly requestTimeout?: number;
};
