import type { FingerprintChanges } from "../../utils/fingerprint/diff";
import type { SigningConfigIssue } from "../../utils/signing/validateSigningConfig";

export type NativePlatform = "ios" | "android";

export interface NativeCheckIssue {
  type: "error" | "warning";
  platform: NativePlatform | "project";
  code:
    | "NATIVE_FILES_NOT_FOUND"
    | "APP_DELEGATE_NOT_FOUND"
    | "MAIN_APPLICATION_NOT_FOUND"
    | "MISSING_IOS_BUNDLE_PROVIDER"
    | "MISSING_ANDROID_BUNDLE_PROVIDER"
    | "MISSING_FINGERPRINT_JSON"
    | "INVALID_FINGERPRINT_JSON"
    | "FINGERPRINT_JSON_STALE"
    | "FINGERPRINT_ENGINE_CHANGED"
    | "FINGERPRINT_ENGINE_UNRECORDED"
    | "FINGERPRINT_JSON_UNUSED"
    | "FINGERPRINT_GENERATION_FAILED"
    | "MISSING_CLIENT_PLUGIN"
    | "CLIENT_PLUGINS_UNCHECKED"
    | "EXPO_SDK_UNSUPPORTED"
    | "SIGNING_PUBLIC_KEY_UNAVAILABLE"
    | "SANDBOX_BUILD_BLOCKED"
    | "SANDBOX_GOOGLE_SERVICES_CLIENT_MISSING"
    | "SANDBOX_UNQUALIFIED"
    | "TESTFLIGHT_COMPLIANCE_UNSET"
    | SigningConfigIssue["code"];
  message: string;
  resolution: string;
  commands?: string[];
  paths?: string[];
  /** FINGERPRINT_JSON_STALE: the sources that changed since fingerprint.json. */
  changes?: FingerprintChanges;
}

/** A finding about the server's release catalogs, by scope. */
export interface ReleaseCatalogIssue {
  type: "error" | "warning";
  code:
    | "RELEASE_CATALOG_STALE"
    | "RELEASE_CATALOG_IDENTITY_MISSING"
    | "RELEASE_CATALOG_CHECK_FAILED"
    | "RELEASE_CATALOGS_UNCHECKED"
    | "RELEASE_SCOPES_UNCHECKED"
    | "RELEASE_SCOPES_UNINDEXED"
    | "RELEASE_CATALOG_PARTITIONING_OFF"
    | "RELEASE_CATALOG_PARTITIONING_SWITCH_MISSING"
    | "RELEASE_CATALOG_PARTITIONING_UNCHECKED"
    | "RELEASE_CATALOG_PARTITIONS_MISSING";
  /** The scope the issue is about; absent when no catalog could be read. */
  scopeKey?: string;
  message: string;
  resolution: string;
  commands?: string[];
}

/** One scope's catalog against a rebuild from its releases. */
export interface ReleaseCatalogScopeStatus {
  scopeKey: string;
  /**
   * `missing`: the scope has releases and no catalog row. `unchecked`: core
   * could not compile it.
   */
  state: "verified" | "stale" | "missing" | "unchecked";
  /** The stored catalog's generation; null without a catalog row. */
  generation: number | null;
  /** The catalog its releases compile to; null when core could not compile it. */
  byteSize: number | null;
  descriptorCount: number | null;
  /**
   * How the scope's own catalog row stores it, as the server reports it;
   * absent from a server before 1.2.0 and for a scope without a row.
   */
  layout?: "compact" | "partitioned";
  /** The scope's update strategy, from its catalog row. */
  strategy?: "APP_VERSION" | "FINGERPRINT";
}

/**
 * The server's partitioning switch, and whether it reads the partitions
 * table. Absent where the server has no such route: before 1.2.0.
 */
export interface ReleaseCatalogPartitioning {
  switch: "on" | "off";
  table: "present" | "missing";
  /**
   * App-version scopes whose own row is still one compact catalog, while
   * the switch is on: each converts on its next write. Not an issue.
   */
  compactScopes: number;
}

/** Every scope with a release catalog, checked without writing. */
export interface ReleaseCatalogStatus {
  scopes: ReleaseCatalogScopeStatus[];
  issues: ReleaseCatalogIssue[];
  partitioning?: ReleaseCatalogPartitioning;
}

/** A schema setting the server's fence found missing or different. */
export interface SchemaSetting {
  readonly key: string;
  readonly expected: string;
  readonly found: string | null;
}

/** A finding about the schema the server's fence checks. */
export interface SchemaIssue {
  type: "error" | "warning";
  code:
    | "SCHEMA_MIGRATION_PENDING"
    | "SCHEMA_NEWER_THAN_CLI"
    | "SCHEMA_NOT_MIGRATABLE"
    | "PLUGIN_SCHEMA_CHANGED";
  /** SCHEMA_MIGRATION_PENDING: the settings a migration writes. */
  settings?: SchemaSetting[];
  message: string;
  resolution: string;
  commands?: string[];
}

/** The server's schema against what this CLI's core and the configured plugins expect. */
export interface SchemaStatus {
  /** Every setting the fence found missing or different. */
  settings: SchemaSetting[];
  issues: SchemaIssue[];
}
