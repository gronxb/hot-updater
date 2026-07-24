export type PersistedUpdateStrategy = "fingerprint" | "appVersion";

export type NotifyAppReadyResult =
  | { readonly status: "UNCHANGED" }
  | {
      readonly fromBundleId: string;
      readonly status: "UPDATE_APPLIED";
      readonly toBundleId: string;
    }
  | {
      readonly fromBundleId: string;
      readonly status: "RECOVERED";
      readonly toBundleId: string;
    };

export type NotifyAppReadyAnalyticsEvent = {
  readonly fromBundleId: string;
  readonly toBundleId: string;
  readonly type: "UPDATE_APPLIED" | "RECOVERED";
  readonly updateStrategy: PersistedUpdateStrategy;
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

type ResolverNotifyAppReadyAnalyticsCommonParams = {
  readonly appVersion: string;
  readonly channel: string;
  readonly cohort: string;
  readonly fingerprintHash: string | null;
  readonly installId: string;
  readonly platform: "ios" | "android";
  readonly requestHeaders?: Record<string, string>;
  readonly requestTimeout?: number;
  readonly userId?: string;
  readonly username?: string;
};

type ResolverNotifyAppReadyTransitionParams =
  ResolverNotifyAppReadyAnalyticsCommonParams & {
    readonly fromBundleId: string;
    readonly toBundleId: string;
    readonly updateStrategy: PersistedUpdateStrategy;
  };

export type ResolverNotifyAppReadyAnalyticsParams =
  | (ResolverNotifyAppReadyTransitionParams & {
      readonly type: "UPDATE_APPLIED";
    })
  | (ResolverNotifyAppReadyTransitionParams & {
      readonly type: "RECOVERED";
    })
  | (ResolverNotifyAppReadyAnalyticsCommonParams & {
      readonly fromBundleId: null;
      readonly toBundleId: string;
      readonly type: "UNCHANGED";
      readonly updateStrategy: null;
    });
