import { createHash } from "node:crypto";

import {
  expectedRawDetailNativeFailure,
  MISSING_ASSET_RESPONSE_SHA256,
} from "../../examples/lynx/scripts/public-matrix/raw-detail-rejection.mjs";
import { SPARKLING_NAVIGATION_PROVENANCE } from "../../packages/lynx/src/navigationProvenance.ts";
import {
  validateMatrixRuntimeJournalDiagnostics,
  validateNavigationStackBoundary,
  validateRuntimeEventFieldBoundaryDiagnostics,
} from "./native-diagnostics-evidence.ts";

export const LYNX_MATRIX_FRAMEWORKS = ["react", "vue", "octane"] as const;
export const LYNX_MATRIX_PLATFORMS = ["ios", "android"] as const;
export const LYNX_MATRIX_RESOURCE_PATHS = [
  "main.lynx.bundle",
  "detail.lynx.bundle",
  "assets/probe.png",
  "assets/probe.ttf",
  "assets/bootstrap.js",
  "dynamic/component.lynx.bundle",
] as const;
export const LYNX_MATRIX_PAGE_ENTRIES = [
  "detail.lynx.bundle",
  "main.lynx.bundle",
] as const;
export const LYNX_MATRIX_PAGE_ESSENTIAL_RESOURCES = [
  { entry: "detail.lynx.bundle", resources: ["detail.lynx.bundle"] },
  {
    entry: "main.lynx.bundle",
    resources: LYNX_MATRIX_RESOURCE_PATHS.filter(
      (path) => path !== "detail.lynx.bundle",
    ),
  },
] as const;

export type LynxMatrixFramework = (typeof LYNX_MATRIX_FRAMEWORKS)[number];
export type LynxMatrixPlatform = (typeof LYNX_MATRIX_PLATFORMS)[number];

export const LYNX_MATRIX_RUNTIME_IDS = {
  ios: "sparkling-c4ce8d2-navigation-2.1.0-rc.12-lynx-3.9.0-primjs-3.8.0-alpha.6-ios-managed-pages-v1",
  android:
    "android-sparkling-2.1.0-rc.12-navsrc-937f70d7c3012a5a-lynx-3.9.0-primjs-3.8.0-alpha.6-managed-pages-v1",
} as const;

export const LYNX_MATRIX_INCOMPATIBLE_RUNTIME_IDS = {
  ios: `${LYNX_MATRIX_RUNTIME_IDS.ios}-cross-provenance-rejected`,
  android: `${LYNX_MATRIX_RUNTIME_IDS.android}-cross-provenance-rejected`,
} as const;

export const LYNX_MATRIX_NATIVE_VERSIONS = {
  sparkling: "2.1.0-rc.12",
  lynx: "3.9.0",
  primjs: "3.8.0-alpha.6",
  hotUpdaterLynx: "1.0.0-rc.14",
} as const;

export const LYNX_MATRIX_IOS_SPARKLING_CHECKOUT = {
  path: "ios/.upstream/sparkling",
  commit: "c4ce8d25c5ea277e13752d68ff1f2a66f5704240",
  archiveSha256:
    "98939fa2d30710cb1b1071a0eb37521a3a8ebd4c2f6a9d81e7828eafe8299337",
} as const;

export const LYNX_MATRIX_ANDROID_SPARKLING_ARTIFACTS = {
  "com.tiktok.sparkling:sparkling:2.1.0-rc.12@aar":
    "3f565f3a1e44ccc3c33d8a53e7ebd1af5e348e1aac3f4a8de83676e0080d64ea",
  "com.tiktok.sparkling:sparkling:2.1.0-rc.12@pom":
    "852ddb134a4f8534b648416594d8d4babb30ac43584e3423d4d1f8d3baf90880",
  "com.tiktok.sparkling:sparkling:2.1.0-rc.12@module":
    "7fd65ca2ef77deaa67102e3cfbf67a376ba95c35c5cdbc225e3ffd9cfa08b8c5",
  "com.tiktok.sparkling:sparkling-method:2.1.0-rc.12@aar":
    "2b5114e07640ff86ee43fc5ae0cd84cf98a53d2c40a19d432bf501496cc54b7a",
  "com.tiktok.sparkling:sparkling-method:2.1.0-rc.12@pom":
    "5d42601a13e3ffcf92fc973248e50b342ad78aa72fc297c051707fca8f207a06",
  "com.tiktok.sparkling:sparkling-method:2.1.0-rc.12@module":
    "01fd39296eddb16f3ab50ed5efd0880737d29d98900d1d7564e9e18637599e17",
} as const;

const LYNX_NATIVE_ALLOWED_PREEXISTING_TRACKED_PATHS = [
  "examples-server/hono-kysely-pglite/hot-updater_migrations/migration_2026-09-11T14-30-47.sql",
  "examples-server/hono-kysely-pglite/src/db.ts",
  "examples-server/hono-kysely-pglite/src/localFsStorage.mjs",
  "examples-server/hono-kysely-pglite/src/localFsStorage.ts",
  "examples/lynx/.gitignore",
  "examples/lynx/scripts/e2e-kysely-deploy.mjs",
] as const;

const LYNX_NATIVE_PUBLIC_KEY_PATHS = {
  android: [
    "examples/lynx/android/app/src/main/AndroidManifest.xml",
    "examples/lynx/android/e2e-app/src/main/AndroidManifest.xml",
    "examples/lynx/android/matrix-app/src/main/AndroidManifest.xml",
  ],
  ios: [
    "examples/lynx/ios/Info.plist",
    "examples/lynx/ios/MatrixHarness/NonProductionInfo.plist",
  ],
} as const;

const LYNX_NATIVE_TARGETS = {
  e2e: { androidModule: "e2e-app", iosScheme: "SparklingGoE2E" },
  matrix: {
    androidModule: "matrix-app",
    iosScheme: "SparklingMatrixHarness",
  },
  scaffold: { androidModule: "app", iosScheme: "SparklingGo" },
} as const;

type JsonRecord = Record<string, unknown>;

function fail(path: string, message: string): never {
  throw new Error(`Invalid Lynx matrix receipt at ${path}: ${message}`);
}

function record(value: unknown, at: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(at, "expected an object");
  }
  return value as JsonRecord;
}

function string(value: unknown, at: string): string {
  if (typeof value !== "string" || value.length === 0) {
    fail(at, "expected a non-empty string");
  }
  return value;
}

function nullableString(value: unknown, at: string): string | null {
  if (value === null) return null;
  return string(value, at);
}

function exactString(value: unknown, expected: string, at: string): void {
  if (value !== expected) fail(at, `expected ${JSON.stringify(expected)}`);
}

function boolean(value: unknown, expected: boolean, at: string): void {
  if (value !== expected) fail(at, `expected ${expected}`);
}

function booleanValue(value: unknown, at: string): boolean {
  if (typeof value !== "boolean") fail(at, "expected a boolean");
  return value;
}

function sequence(value: unknown, at: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    fail(at, "expected a non-negative event sequence");
  }
  return value as number;
}

function hash(value: unknown, at: string): string {
  const result = string(value, at);
  if (!/^[a-f0-9]{64}$/.test(result)) fail(at, "expected a SHA-256 hash");
  return result;
}

function nativeConfigSha256(files: JsonRecord): string {
  return createHash("sha256")
    .update(
      Buffer.from(
        Object.entries(files)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([file, digest]) => `${file}\0${digest}\n`)
          .join(""),
      ),
    )
    .digest("hex");
}

function nativeConfigPaths(
  platform: LynxMatrixPlatform,
  target: keyof typeof LYNX_NATIVE_TARGETS,
  includesPublicKey: boolean,
) {
  const definition = LYNX_NATIVE_TARGETS[target];
  const base =
    platform === "ios"
      ? [
          "examples/lynx/fingerprint.json",
          "examples/lynx/ios/Podfile",
          "examples/lynx/ios/Podfile.lock",
          "examples/lynx/ios/SparklingGo.xcodeproj/project.pbxproj",
          `examples/lynx/ios/SparklingGo.xcodeproj/xcshareddata/xcschemes/${definition.iosScheme}.xcscheme`,
        ]
      : [
          "examples/lynx/fingerprint.json",
          "examples/lynx/android/settings.gradle.kts",
          "examples/lynx/android/gradle.properties",
          `examples/lynx/android/${definition.androidModule}/build.gradle.kts`,
          "packages/lynx/android/build.gradle",
          "packages/lynx/android-sparkling/build.gradle",
        ];
  return includesPublicKey
    ? [...base, ...LYNX_NATIVE_PUBLIC_KEY_PATHS[platform]]
    : base;
}

function nativePublicKeyInjection(
  value: unknown,
  expectedFiles: readonly string[],
  at: string,
) {
  const injection = record(value, at);
  if (injection.schemaVersion !== 1) {
    fail(`${at}.schemaVersion`, "expected 1");
  }
  exactString(
    injection.provenance,
    "post-fingerprint-trust-anchor-injection",
    `${at}.provenance`,
  );
  boolean(
    injection.runtimeFingerprintRecalculated,
    false,
    `${at}.runtimeFingerprintRecalculated`,
  );
  exactString(injection.algorithm, "rsa-spki", `${at}.algorithm`);
  if (
    !Number.isSafeInteger(injection.modulusLength) ||
    (injection.modulusLength as number) < 2048
  ) {
    fail(`${at}.modulusLength`, "expected RSA modulus of at least 2048 bits");
  }
  hash(injection.spkiSha256, `${at}.spkiSha256`);
  const files = record(injection.files, `${at}.files`);
  sameMembers(Object.keys(files), expectedFiles, `${at}.files`);
  for (const file of expectedFiles) {
    hash(files[file], `${at}.files.${file}`);
  }
  return { injection, files };
}

function absoluteUrl(value: unknown, at: string): string {
  const result = string(value, at);
  let parsed: URL;
  try {
    parsed = new URL(result);
  } catch {
    return fail(at, "expected an absolute URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    fail(at, "expected an HTTP(S) URL");
  }
  return result;
}

export function validateLynxNativeArtifactsReceipt(
  value: unknown,
  options: {
    readonly appId: string;
    readonly commit?: string;
    readonly platforms: readonly LynxMatrixPlatform[];
    readonly target: "e2e" | "matrix" | "scaffold";
  },
): JsonRecord {
  const receipt = record(value, "nativeArtifacts");
  exactString(
    receipt.schemaVersion,
    "lynx-native-artifacts-v2",
    "nativeArtifacts.schemaVersion",
  );
  exactString(receipt.target, options.target, "nativeArtifacts.target");
  exactString(receipt.appId, options.appId, "nativeArtifacts.appId");
  const sourceCommit = string(
    receipt.sourceCommit,
    "nativeArtifacts.sourceCommit",
  );
  if (!/^[a-f0-9]{40}$/.test(sourceCommit)) {
    fail("nativeArtifacts.sourceCommit", "expected a full Git commit");
  }
  if (options.commit !== undefined && sourceCommit !== options.commit) {
    fail("nativeArtifacts.sourceCommit", "does not match the matrix commit");
  }
  const sourceIntegrity = record(
    receipt.sourceIntegrity,
    "nativeArtifacts.sourceIntegrity",
  );
  exactString(
    sourceIntegrity.checkedCommit,
    sourceCommit,
    "nativeArtifacts.sourceIntegrity.checkedCommit",
  );
  boolean(sourceIntegrity.clean, true, "nativeArtifacts.sourceIntegrity.clean");
  hash(
    sourceIntegrity.trackedTreeSha256,
    "nativeArtifacts.sourceIntegrity.trackedTreeSha256",
  );
  if (
    !Array.isArray(sourceIntegrity.trackedChanges) ||
    sourceIntegrity.trackedChanges.length !== 0
  ) {
    fail(
      "nativeArtifacts.sourceIntegrity.trackedChanges",
      "expected no tracked source changes",
    );
  }
  if (
    JSON.stringify(sourceIntegrity.allowedTrackedChanges) !==
    JSON.stringify(LYNX_NATIVE_ALLOWED_PREEXISTING_TRACKED_PATHS)
  ) {
    fail(
      "nativeArtifacts.sourceIntegrity.allowedTrackedChanges",
      "expected only the preserved preexisting staged paths",
    );
  }
  const sourcePublicKey =
    sourceIntegrity.nativePublicKeyInjection === undefined
      ? null
      : nativePublicKeyInjection(
          sourceIntegrity.nativePublicKeyInjection,
          Object.values(LYNX_NATIVE_PUBLIC_KEY_PATHS).flat(),
          "nativeArtifacts.sourceIntegrity.nativePublicKeyInjection",
        );
  if (
    JSON.stringify(receipt.versions) !==
    JSON.stringify(LYNX_MATRIX_NATIVE_VERSIONS)
  ) {
    fail("nativeArtifacts.versions", "expected exact native module versions");
  }
  if (
    JSON.stringify(receipt.sparklingNavigation) !==
    JSON.stringify(SPARKLING_NAVIGATION_PROVENANCE)
  ) {
    fail(
      "nativeArtifacts.sparklingNavigation",
      "expected exact Sparkling navigation provenance",
    );
  }
  const artifacts = record(receipt.artifacts, "nativeArtifacts.artifacts");
  for (const platform of options.platforms) {
    const at = `nativeArtifacts.artifacts.${platform}`;
    const artifact = record(artifacts[platform], at);
    const artifactPath = string(artifact.path, `${at}.path`);
    if (!artifactPath.startsWith("/")) fail(`${at}.path`, "must be absolute");
    exactString(artifact.sourceCommit, sourceCommit, `${at}.sourceCommit`);
    exactString(artifact.appId, options.appId, `${at}.appId`);
    exactString(
      artifact.runtimeId,
      LYNX_MATRIX_RUNTIME_IDS[platform],
      `${at}.runtimeId`,
    );
    hash(artifact.binarySha256, `${at}.binarySha256`);
    exactString(
      artifact.artifactHashKind,
      platform === "ios" ? "deterministic-full-app-tree-v1" : "full-apk-bytes",
      `${at}.artifactHashKind`,
    );
    hash(artifact.nativeFingerprintSha256, `${at}.nativeFingerprintSha256`);
    const nativeConfig = record(artifact.nativeConfig, `${at}.nativeConfig`);
    const files = record(nativeConfig.files, `${at}.nativeConfig.files`);
    sameMembers(
      Object.keys(files),
      nativeConfigPaths(platform, options.target, sourcePublicKey !== null),
      `${at}.nativeConfig.files`,
    );
    for (const [file, digest] of Object.entries(files)) {
      if (!file || file.startsWith("/") || file.split("/").includes("..")) {
        fail(
          `${at}.nativeConfig.files`,
          "paths must be qualified and relative",
        );
      }
      hash(digest, `${at}.nativeConfig.files.${file}`);
    }
    exactString(
      nativeConfig.sha256,
      nativeConfigSha256(files),
      `${at}.nativeConfig.sha256`,
    );
    if (sourcePublicKey === null) {
      if (nativeConfig.nativePublicKeyInjection !== undefined) {
        fail(
          `${at}.nativeConfig.nativePublicKeyInjection`,
          "must be absent when source integrity has no key injection",
        );
      }
      for (const file of LYNX_NATIVE_PUBLIC_KEY_PATHS[platform]) {
        if (file in files) {
          fail(
            `${at}.nativeConfig.files.${file}`,
            "must be absent when source integrity has no key injection",
          );
        }
      }
    } else {
      const configPublicKey = nativePublicKeyInjection(
        nativeConfig.nativePublicKeyInjection,
        LYNX_NATIVE_PUBLIC_KEY_PATHS[platform],
        `${at}.nativeConfig.nativePublicKeyInjection`,
      );
      for (const field of [
        "schemaVersion",
        "provenance",
        "runtimeFingerprintRecalculated",
        "algorithm",
        "modulusLength",
        "spkiSha256",
      ]) {
        if (
          configPublicKey.injection[field] !== sourcePublicKey.injection[field]
        ) {
          fail(
            `${at}.nativeConfig.nativePublicKeyInjection.${field}`,
            "does not match source integrity",
          );
        }
      }
      for (const file of LYNX_NATIVE_PUBLIC_KEY_PATHS[platform]) {
        if (
          configPublicKey.files[file] !== sourcePublicKey.files[file] ||
          files[file] !== sourcePublicKey.files[file]
        ) {
          fail(
            `${at}.nativeConfig.files.${file}`,
            "does not match the injected source file",
          );
        }
      }
    }
    if (platform === "ios") {
      if (
        JSON.stringify(artifact.sparklingCheckout) !==
        JSON.stringify(LYNX_MATRIX_IOS_SPARKLING_CHECKOUT)
      ) {
        fail(`${at}.sparklingCheckout`, "expected the resolved iOS checkout");
      }
      string(artifact.scheme, `${at}.scheme`);
      string(artifact.arch, `${at}.arch`);
    } else {
      if (
        JSON.stringify(artifact.sparklingArtifacts) !==
        JSON.stringify(LYNX_MATRIX_ANDROID_SPARKLING_ARTIFACTS)
      ) {
        fail(
          `${at}.sparklingArtifacts`,
          "expected exact Android AAR/POM/module checksums",
        );
      }
      exactString(
        artifact.sparklingDependencyGraphSha256,
        "c68329c1968de962c8574f298ba46f43db016195bbbf4422b5e01145278aebe3",
        `${at}.sparklingDependencyGraphSha256`,
      );
      string(artifact.task, `${at}.task`);
      if (!Array.isArray(artifact.abis) || artifact.abis.length !== 1) {
        fail(`${at}.abis`, "expected one exact build ABI");
      }
    }
  }
  return receipt;
}

function stringArray(value: unknown, at: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    fail(at, "expected an array of strings");
  }
  return value as string[];
}

function sameMembers(
  actual: string[],
  expected: readonly string[],
  at: string,
) {
  if (
    actual.length !== new Set(actual).size ||
    actual.length !== expected.length ||
    actual.some((value) => !expected.includes(value))
  ) {
    fail(at, `expected exactly ${JSON.stringify(expected)}`);
  }
}

function selection(value: unknown, at: string) {
  const item = record(value, at);
  return {
    bundleId: string(item.bundleId, `${at}.bundleId`),
    releaseId: string(item.releaseId, `${at}.releaseId`),
  };
}

function selectionSummary(value: unknown, at: string) {
  const item = record(value, at);
  const kind = string(item.kind, `${at}.kind`);
  if (kind !== "BUNDLE" && kind !== "EMBEDDED" && kind !== "BUILTIN") {
    fail(`${at}.kind`, "expected BUNDLE, EMBEDDED, or BUILTIN");
  }
  return {
    kind,
    bundleId: string(item.bundleId, `${at}.bundleId`),
    releaseId: nullableString(item.releaseId, `${at}.releaseId`),
    channel: string(item.channel, `${at}.channel`),
  };
}

type ExpectedSelection = {
  bundleId: string;
  releaseId: string | null;
};

function nativeConfirmation(
  value: unknown,
  expectedStatus: "CONFIRMED" | "ALREADY_CONFIRMED",
  expectedTransition: null | {
    kind: "UPDATE_APPLIED" | "RECOVERED";
    from: ExpectedSelection;
    to: ExpectedSelection;
  },
  at: string,
) {
  const item = record(value, at);
  exactString(item.status, expectedStatus, `${at}.status`);
  if (expectedTransition === null) {
    if (item.transition !== null) {
      fail(`${at}.transition`, "expected no native launch transition");
    }
    return;
  }
  const transition = record(item.transition, `${at}.transition`);
  exactString(
    transition.kind,
    expectedTransition.kind,
    `${at}.transition.kind`,
  );
  const from = selectionSummary(transition.from, `${at}.transition.from`);
  const to = selectionSummary(transition.to, `${at}.transition.to`);
  if (from.bundleId === to.bundleId || from.releaseId === to.releaseId) {
    fail(
      `${at}.transition`,
      "from and to must have distinct bundle and release identities",
    );
  }
  if (
    from.bundleId !== expectedTransition.from.bundleId ||
    from.releaseId !== expectedTransition.from.releaseId
  ) {
    fail(`${at}.transition.from`, "does not match the prior native selection");
  }
  if (
    to.bundleId !== expectedTransition.to.bundleId ||
    to.releaseId !== expectedTransition.to.releaseId
  ) {
    fail(`${at}.transition.to`, "does not match the launched candidate");
  }
}

function identity(value: unknown, at: string) {
  const item = record(value, at);
  const processId = string(item.processId, `${at}.processId`);
  if (!/^[1-9][0-9]*$/.test(processId)) {
    fail(`${at}.processId`, "expected a canonical positive decimal string");
  }
  return {
    runtimeId: string(item.runtimeId, `${at}.runtimeId`),
    processId,
    generationId: string(item.generationId, `${at}.generationId`),
    contextId: string(item.contextId, `${at}.contextId`),
    attemptId: string(item.attemptId, `${at}.attemptId`),
    bundleId: string(item.bundleId, `${at}.bundleId`),
    releaseId: nullableString(item.releaseId, `${at}.releaseId`),
  };
}

function resources(
  value: unknown,
  expected: JsonRecord,
  at: string,
  expectedPaths: readonly string[] = LYNX_MATRIX_RESOURCE_PATHS,
) {
  if (!Array.isArray(value)) fail(at, "expected an array");
  const paths = value.map((raw, index) => {
    const itemAt = `${at}[${index}]`;
    const item = record(raw, itemAt);
    const resourcePath = string(item.path, `${itemAt}.path`);
    if (!LYNX_MATRIX_RESOURCE_PATHS.includes(resourcePath as never)) {
      fail(`${itemAt}.path`, `unexpected resource ${resourcePath}`);
    }
    const expectedResource = record(
      expected[resourcePath],
      `build.files.${resourcePath}`,
    );
    const expectedHash = hash(
      expectedResource.sha256,
      `build.files.${resourcePath}.sha256`,
    );
    const observedHash = hash(item.sha256, `${itemAt}.sha256`);
    if (observedHash !== expectedHash) {
      fail(
        `${itemAt}.sha256`,
        `does not match compiler output for ${resourcePath}`,
      );
    }
    const loadedSequence = sequence(
      item.loadedSequence,
      `${itemAt}.loadedSequence`,
    );
    boolean(item.leaseAcquired, true, `${itemAt}.leaseAcquired`);
    booleanValue(item.leaseReleased, `${itemAt}.leaseReleased`);
    const acquiredSequence = sequence(
      item.leaseAcquiredSequence,
      `${itemAt}.leaseAcquiredSequence`,
    );
    if (acquiredSequence > loadedSequence) {
      fail(itemAt, "resource lease must be acquired before resourceLoaded");
    }
    if (item.leaseReleased === true) {
      sequence(item.leaseReleasedSequence, `${itemAt}.leaseReleasedSequence`);
    } else if (item.leaseReleasedSequence !== null) {
      fail(`${itemAt}.leaseReleasedSequence`, "expected null without release");
    }
    return resourcePath;
  });
  sameMembers(paths, expectedPaths, at);
}

function launchMembers(
  value: unknown,
  contextIds: string[],
  primaryIdentity: ReturnType<typeof identity>,
  expectedBuild: JsonRecord,
  at: string,
  requireReady: boolean,
  requireDetailReady: boolean,
  confirmation: unknown,
) {
  if (!Array.isArray(value)) fail(at, "expected an array");
  let primaryMember: JsonRecord | undefined;
  const observedContextIds = value.map((raw, index) => {
    const memberAt = `${at}[${index}]`;
    const member = record(raw, memberAt);
    const memberIdentity = identity(member.identity, `${memberAt}.identity`);
    if (
      memberIdentity.processId !== primaryIdentity.processId ||
      memberIdentity.generationId !== primaryIdentity.generationId ||
      memberIdentity.attemptId !== primaryIdentity.attemptId ||
      memberIdentity.bundleId !== primaryIdentity.bundleId ||
      memberIdentity.releaseId !== primaryIdentity.releaseId
    ) {
      fail(`${memberAt}.identity`, "must belong to the declared generation");
    }
    boolean(
      member.primary,
      memberIdentity.contextId === primaryIdentity.contextId,
      `${memberAt}.primary`,
    );
    if (member.primary === true) primaryMember = member;
    const pageEntry = string(member.pageEntry, `${memberAt}.pageEntry`);
    exactString(
      pageEntry,
      member.primary === true ? "main.lynx.bundle" : "detail.lynx.bundle",
      `${memberAt}.pageEntry`,
    );
    boolean(
      member.readinessAuthority,
      memberIdentity.contextId === primaryIdentity.contextId,
      `${memberAt}.readinessAuthority`,
    );
    const evaluationSequence = sequence(
      member.evaluationSequence,
      `${memberAt}.evaluationSequence`,
    );
    const firstContent = identity(
      member.firstContent,
      `${memberAt}.firstContent`,
    );
    if (JSON.stringify(firstContent) !== JSON.stringify(memberIdentity)) {
      fail(`${memberAt}.firstContent`, "must match the member identity");
    }
    const firstContentSequence = sequence(
      member.firstContentSequence,
      `${memberAt}.firstContentSequence`,
    );
    if (evaluationSequence >= firstContentSequence) {
      fail(memberAt, "generationWillEvaluate must precede firstContent");
    }
    resources(
      member.resources,
      record(expectedBuild.files, "build.files"),
      `${memberAt}.resources`,
      member.primary === true
        ? LYNX_MATRIX_RESOURCE_PATHS.filter(
            (path) => path !== "detail.lynx.bundle",
          )
        : ["detail.lynx.bundle"],
    );
    if (requireReady && member.primary === true) {
      record(member.confirmation, `${memberAt}.confirmation`);
      if (
        JSON.stringify(member.confirmation) !== JSON.stringify(confirmation)
      ) {
        fail(
          `${memberAt}.confirmation`,
          "must equal the primary generation confirmation receipt",
        );
      }
      const jsReady = identity(member.jsReady, `${memberAt}.jsReady`);
      if (JSON.stringify(jsReady) !== JSON.stringify(memberIdentity)) {
        fail(`${memberAt}.jsReady`, "must match the member identity");
      }
      const jsReadySequence = sequence(
        member.jsReadySequence,
        `${memberAt}.jsReadySequence`,
      );
      if (firstContentSequence >= jsReadySequence) {
        fail(memberAt, "firstContent must precede jsReady");
      }
      for (const resource of member.resources as JsonRecord[]) {
        if (sequence(resource.loadedSequence, memberAt) >= jsReadySequence) {
          fail(memberAt, "required resources must complete before jsReady");
        }
      }
    } else if (member.primary === true) {
      if (
        member.jsReady !== null ||
        member.jsReadySequence !== null ||
        member.confirmation !== null
      ) {
        fail(memberAt, "unconfirmed primary must not contain jsReady evidence");
      }
    } else if (requireDetailReady) {
      if (member.jsReady !== null || member.jsReadySequence !== null) {
        fail(memberAt, "detail page must not claim primary jsReady authority");
      }
      const admitted = identity(
        member.pageAdmitted,
        `${memberAt}.pageAdmitted`,
      );
      if (JSON.stringify(admitted) !== JSON.stringify(memberIdentity)) {
        fail(`${memberAt}.pageAdmitted`, "must match the detail identity");
      }
      const admission = record(member.confirmation, `${memberAt}.confirmation`);
      exactString(
        admission.status,
        "PAGE_ADMITTED",
        `${memberAt}.confirmation.status`,
      );
      string(member.nativePageClass, `${memberAt}.nativePageClass`);
      exactString(
        member.sourceContextId,
        primaryIdentity.contextId,
        `${memberAt}.sourceContextId`,
      );
      const parameters = record(member.parameters, `${memberAt}.parameters`);
      exactString(
        parameters.title,
        "Second Page",
        `${memberAt}.parameters.title`,
      );
      const terminal = record(
        member.pageAttemptTerminal,
        `${memberAt}.pageAttemptTerminal`,
      );
      const terminalIdentity = identity(
        terminal,
        `${memberAt}.pageAttemptTerminal`,
      );
      if (JSON.stringify(terminalIdentity) !== JSON.stringify(memberIdentity)) {
        fail(
          `${memberAt}.pageAttemptTerminal`,
          "must match the detail identity",
        );
      }
      string(
        terminal.pageAttemptId,
        `${memberAt}.pageAttemptTerminal.pageAttemptId`,
      );
      exactString(
        terminal.terminal,
        "admitted",
        `${memberAt}.pageAttemptTerminal.terminal`,
      );
    } else {
      if (
        member.pageAdmitted !== null ||
        member.pageAttemptTerminal !== null ||
        member.confirmation !== null
      ) {
        fail(
          memberAt,
          "pending detail must not contain admission or terminal evidence",
        );
      }
      string(member.nativePageClass, `${memberAt}.nativePageClass`);
      exactString(
        member.sourceContextId,
        primaryIdentity.contextId,
        `${memberAt}.sourceContextId`,
      );
      const parameters = record(member.parameters, `${memberAt}.parameters`);
      exactString(
        parameters.title,
        "Second Page",
        `${memberAt}.parameters.title`,
      );
    }
    return memberIdentity.contextId;
  });
  sameMembers(observedContextIds, contextIds, at);
  if (!primaryMember) fail(at, "missing the authoritative primary member");
  return primaryMember;
}

function readyLaunch(
  value: unknown,
  expectedBuild: JsonRecord,
  at: string,
  expectedSelection?: { bundleId: string; releaseId: string | null },
) {
  const item = record(value, at);
  booleanValue(item.reconstructedStack, `${at}.reconstructedStack`);
  const launchIdentity = identity(item.identity, `${at}.identity`);
  const firstContent = identity(item.firstContent, `${at}.firstContent`);
  const jsReady = identity(item.jsReady, `${at}.jsReady`);
  if (JSON.stringify(firstContent) !== JSON.stringify(launchIdentity)) {
    fail(`${at}.firstContent`, "must belong to the primary launch identity");
  }
  if (JSON.stringify(jsReady) !== JSON.stringify(launchIdentity)) {
    fail(`${at}.jsReady`, "must belong to the primary launch identity");
  }
  if (
    launchIdentity.bundleId !==
      string(expectedBuild.bundleId, "build.bundleId") ||
    launchIdentity.releaseId !==
      nullableString(expectedBuild.releaseId, "build.releaseId")
  ) {
    fail(`${at}.identity`, "does not match the expected release");
  }
  if (
    launchIdentity.runtimeId !==
    string(expectedBuild.runtimeId, "build.runtimeId")
  ) {
    fail(`${at}.identity.runtimeId`, "does not match the expected runtime");
  }
  if (
    expectedSelection &&
    (launchIdentity.bundleId !== expectedSelection.bundleId ||
      launchIdentity.releaseId !== expectedSelection.releaseId)
  ) {
    fail(`${at}.identity`, "does not match the staged selection");
  }
  const contextIds = stringArray(item.contextIds, `${at}.contextIds`);
  if (
    contextIds.length < 2 ||
    contextIds.length !== new Set(contextIds).size ||
    !contextIds.includes(launchIdentity.contextId)
  ) {
    fail(
      `${at}.contextIds`,
      "must contain a unique primary and at least one managed secondary context",
    );
  }
  resources(
    item.resources,
    record(expectedBuild.files, "build.files"),
    `${at}.resources`,
    LYNX_MATRIX_RESOURCE_PATHS.filter((path) => path !== "detail.lynx.bundle"),
  );
  const primaryMember = launchMembers(
    item.members,
    contextIds,
    launchIdentity,
    expectedBuild,
    `${at}.members`,
    true,
    true,
    item.confirmation,
  );
  for (const key of [
    "evaluationSequence",
    "firstContentSequence",
    "jsReadySequence",
    "firstContent",
    "jsReady",
    "confirmation",
    "resources",
  ]) {
    if (JSON.stringify(item[key]) !== JSON.stringify(primaryMember[key])) {
      fail(`${at}.${key}`, "must equal the authoritative primary member");
    }
  }
  const evaluationSequence = sequence(
    item.evaluationSequence,
    `${at}.evaluationSequence`,
  );
  const firstContentSequence = sequence(
    item.firstContentSequence,
    `${at}.firstContentSequence`,
  );
  const jsReadySequence = sequence(
    item.jsReadySequence,
    `${at}.jsReadySequence`,
  );
  if (
    evaluationSequence >= firstContentSequence ||
    firstContentSequence >= jsReadySequence
  ) {
    fail(
      at,
      "generationWillEvaluate must precede firstContent, which must precede jsReady",
    );
  }
  for (const [index, resource] of (item.resources as JsonRecord[]).entries()) {
    if (
      sequence(
        resource.loadedSequence,
        `${at}.resources[${index}].loadedSequence`,
      ) >= jsReadySequence
    ) {
      fail(
        `${at}.resources[${index}]`,
        "required resource must load before jsReady",
      );
    }
  }
  return {
    identity: launchIdentity,
    contextIds,
    resources: item.resources as JsonRecord[],
    members: item.members as JsonRecord[],
    confirmation: item.confirmation,
    reconstructedStack: item.reconstructedStack as boolean,
  };
}

function unconfirmedLaunch(
  value: unknown,
  expectedBuild: JsonRecord,
  at: string,
  expectedSelection: { bundleId: string; releaseId: string | null },
  primaryReady = false,
) {
  const item = record(value, at);
  const launchIdentity = identity(item.identity, `${at}.identity`);
  const firstContent = identity(item.firstContent, `${at}.firstContent`);
  if (JSON.stringify(firstContent) !== JSON.stringify(launchIdentity)) {
    fail(`${at}.firstContent`, "must belong to the primary launch identity");
  }
  if (
    launchIdentity.bundleId !==
      string(expectedBuild.bundleId, "build.bundleId") ||
    launchIdentity.releaseId !==
      nullableString(expectedBuild.releaseId, "build.releaseId") ||
    launchIdentity.bundleId !== expectedSelection.bundleId ||
    launchIdentity.releaseId !== expectedSelection.releaseId
  ) {
    fail(`${at}.identity`, "does not match the unconfirmed candidate");
  }
  const contextIds = stringArray(item.contextIds, `${at}.contextIds`);
  if (
    contextIds.length < 2 ||
    contextIds.length !== new Set(contextIds).size ||
    !contextIds.includes(launchIdentity.contextId)
  ) {
    fail(`${at}.contextIds`, "must declare a primary and managed secondary");
  }
  resources(
    item.resources,
    record(expectedBuild.files, "build.files"),
    `${at}.resources`,
    LYNX_MATRIX_RESOURCE_PATHS.filter((path) => path !== "detail.lynx.bundle"),
  );
  const primaryMember = launchMembers(
    item.members,
    contextIds,
    launchIdentity,
    expectedBuild,
    `${at}.members`,
    primaryReady,
    false,
    item.confirmation,
  );
  for (const key of [
    "evaluationSequence",
    "firstContentSequence",
    "jsReadySequence",
    "firstContent",
    "jsReady",
    "confirmation",
    "resources",
  ]) {
    if (JSON.stringify(item[key]) !== JSON.stringify(primaryMember[key])) {
      fail(`${at}.${key}`, "must equal the authoritative primary member");
    }
  }
  const evaluationSequence = sequence(
    item.evaluationSequence,
    `${at}.evaluationSequence`,
  );
  const firstContentSequence = sequence(
    item.firstContentSequence,
    `${at}.firstContentSequence`,
  );
  if (evaluationSequence >= firstContentSequence) {
    fail(`${at}.firstContentSequence`, "must follow generationWillEvaluate");
  }
  boolean(item.readinessWithheld, !primaryReady, `${at}.readinessWithheld`);
  boolean(item.detailReadinessWithheld, true, `${at}.detailReadinessWithheld`);
  if (
    !primaryReady &&
    (item.jsReady !== null ||
      item.jsReadySequence !== null ||
      item.confirmation !== null)
  ) {
    fail(at, "unconfirmed candidate must not contain jsReady evidence");
  }
  return {
    identity: launchIdentity,
    contextIds,
    resources: item.resources as JsonRecord[],
    members: item.members as JsonRecord[],
    confirmation: item.confirmation,
  };
}

function fatalPendingLaunch(
  value: unknown,
  expectedBuild: JsonRecord,
  at: string,
  expectedSelection: { bundleId: string; releaseId: string | null },
  primaryReady: boolean,
) {
  const item = record(value, at);
  const launchIdentity = identity(item.identity, `${at}.identity`);
  if (
    launchIdentity.bundleId !==
      string(expectedBuild.bundleId, "build.bundleId") ||
    launchIdentity.releaseId !==
      nullableString(expectedBuild.releaseId, "build.releaseId") ||
    launchIdentity.bundleId !== expectedSelection.bundleId ||
    launchIdentity.releaseId !== expectedSelection.releaseId
  ) {
    fail(`${at}.identity`, "does not match the fatal candidate selection");
  }
  const contextIds = stringArray(item.contextIds, `${at}.contextIds`);
  if (
    contextIds.length !== 2 ||
    contextIds.length !== new Set(contextIds).size ||
    !contextIds.includes(launchIdentity.contextId)
  ) {
    fail(`${at}.contextIds`, "must contain one primary and one pending detail");
  }
  const primaryMember = launchMembers(
    item.members,
    contextIds,
    launchIdentity,
    expectedBuild,
    `${at}.members`,
    primaryReady,
    false,
    item.confirmation,
  );
  for (const key of [
    "evaluationSequence",
    "firstContentSequence",
    "jsReadySequence",
    "firstContent",
    "jsReady",
    "confirmation",
    "resources",
  ]) {
    if (JSON.stringify(item[key]) !== JSON.stringify(primaryMember[key])) {
      fail(`${at}.${key}`, "must equal the authoritative primary member");
    }
  }
  boolean(item.readinessWithheld, !primaryReady, `${at}.readinessWithheld`);
  boolean(item.detailReadinessWithheld, true, `${at}.detailReadinessWithheld`);
  boolean(
    item.detailFailedBeforeAdmission,
    true,
    `${at}.detailFailedBeforeAdmission`,
  );
  return {
    identity: launchIdentity,
    contextIds,
    resources: item.resources as JsonRecord[],
    members: item.members as JsonRecord[],
    confirmation: item.confirmation,
  };
}

function generationRetirement(
  value: unknown,
  before: ReturnType<typeof readyLaunch>,
  at: string,
  requireStaleAuthorities: boolean,
) {
  const item = record(value, at);
  exactString(item.leaseScope, "context", `${at}.leaseScope`);
  const contextIds = stringArray(item.contextIds, `${at}.contextIds`);
  sameMembers(contextIds, before.contextIds, `${at}.contextIds`);
  if (
    item.expectedLeaseCount !==
    before.members.reduce(
      (count, member) =>
        count +
        (Array.isArray((member as JsonRecord).resources)
          ? ((member as JsonRecord).resources as unknown[]).length
          : 0),
      0,
    )
  ) {
    fail(
      `${at}.expectedLeaseCount`,
      "must include one lease per managed context and required resource",
    );
  }
  if (item.inFlightResourceCount !== 0) {
    fail(
      `${at}.inFlightResourceCount`,
      "expected zero accepted resource requests at generationRetired",
    );
  }
  const willRetireSequence = sequence(
    item.willRetireSequence,
    `${at}.willRetireSequence`,
  );
  const retiredSequence = sequence(
    item.retiredSequence,
    `${at}.retiredSequence`,
  );
  if (retiredSequence <= willRetireSequence) {
    fail(at, "generationRetired must follow generationWillRetire");
  }
  boolean(item.allLeasesBalanced, true, `${at}.allLeasesBalanced`);
  if (item.lateOldContextEventCount !== 0) {
    fail(
      `${at}.lateOldContextEventCount`,
      "expected zero late old-context events",
    );
  }
  if (!Array.isArray(item.staleContextRejections)) {
    fail(`${at}.staleContextRejections`, "expected an array");
  }
  const rejectedContextIds = item.staleContextRejections.map((raw, index) => {
    const rejectionAt = `${at}.staleContextRejections[${index}]`;
    const rejection = record(raw, rejectionAt);
    exactString(rejection.code, "STALE_CONTEXT", `${rejectionAt}.code`);
    const rejectedIdentity = identity(rejection, rejectionAt);
    if (
      rejectedIdentity.processId !== before.identity.processId ||
      rejectedIdentity.generationId !== before.identity.generationId ||
      rejectedIdentity.attemptId !== before.identity.attemptId ||
      rejectedIdentity.bundleId !== before.identity.bundleId ||
      rejectedIdentity.releaseId !== before.identity.releaseId
    ) {
      fail(rejectionAt, "must retain the retired generation identity");
    }
    return rejectedIdentity.contextId;
  });
  if (requireStaleAuthorities) {
    sameMembers(
      rejectedContextIds,
      before.contextIds,
      `${at}.staleContextRejections`,
    );
  } else if (rejectedContextIds.length !== 0) {
    fail(`${at}.staleContextRejections`, "expected no diagnostic probes");
  }
  boolean(
    item.oldContextsInvalidated,
    requireStaleAuthorities,
    `${at}.oldContextsInvalidated`,
  );
  for (const [memberIndex, rawMember] of before.members.entries()) {
    const member = record(rawMember, `${at}.members[${memberIndex}]`);
    if (!Array.isArray(member.resources)) {
      fail(`${at}.members[${memberIndex}].resources`, "expected an array");
    }
    for (const [resourceIndex, rawResource] of member.resources.entries()) {
      const resourceAt = `${at}.members[${memberIndex}].resources[${resourceIndex}]`;
      const resource = record(rawResource, resourceAt);
      boolean(resource.leaseReleased, true, `${resourceAt}.leaseReleased`);
      const acquired = sequence(
        resource.leaseAcquiredSequence,
        `${resourceAt}.leaseAcquiredSequence`,
      );
      const released = sequence(
        resource.leaseReleasedSequence,
        `${resourceAt}.leaseReleasedSequence`,
      );
      if (
        acquired >= willRetireSequence ||
        released <= willRetireSequence ||
        released >= retiredSequence
      ) {
        fail(
          resourceAt,
          "lease must be acquired before retirement, then released before generationRetired",
        );
      }
    }
  }
  return { contextIds, willRetireSequence, retiredSequence };
}

function build(
  value: unknown,
  variant: string,
  at: string,
  allowEmbeddedRelease = false,
) {
  const item = record(value, at);
  exactString(item.variant, variant, `${at}.variant`);
  string(item.compiler, `${at}.compiler`);
  string(item.compilerVersion, `${at}.compilerVersion`);
  string(item.runtimeId, `${at}.runtimeId`);
  string(item.bundleId, `${at}.bundleId`);
  const source = string(item.source, `${at}.source`);
  if (!source.startsWith("/"))
    fail(`${at}.source`, "expected an absolute path");
  const provenance = record(item.provenance, `${at}.provenance`);
  exactString(
    provenance.framework,
    string(item.compiler, `${at}.compiler`),
    `${at}.provenance.framework`,
  );
  exactString(
    provenance.rspeedy,
    string(item.compilerVersion, `${at}.compilerVersion`),
    `${at}.provenance.rspeedy`,
  );
  if (
    JSON.stringify(provenance.sparklingNavigation) !==
    JSON.stringify(SPARKLING_NAVIGATION_PROVENANCE)
  ) {
    fail(
      `${at}.provenance.sparklingNavigation`,
      "expected the locked compiler Sparkling provenance",
    );
  }
  if (allowEmbeddedRelease) nullableString(item.releaseId, `${at}.releaseId`);
  else string(item.releaseId, `${at}.releaseId`);
  hash(item.manifestSha256, `${at}.manifestSha256`);
  const pageEntries = stringArray(item.pageEntries, `${at}.pageEntries`);
  if (
    JSON.stringify(pageEntries) !== JSON.stringify(LYNX_MATRIX_PAGE_ENTRIES)
  ) {
    fail(`${at}.pageEntries`, "expected the exact ordered compiler page set");
  }
  if (
    JSON.stringify(item.pageEssentialResources) !==
    JSON.stringify(LYNX_MATRIX_PAGE_ESSENTIAL_RESOURCES)
  ) {
    fail(
      `${at}.pageEssentialResources`,
      "expected the exact compiler-authored per-page resource graph",
    );
  }
  if (
    JSON.stringify(item.sparklingNavigation) !==
    JSON.stringify(SPARKLING_NAVIGATION_PROVENANCE)
  ) {
    fail(
      `${at}.sparklingNavigation`,
      "expected the locked Sparkling navigation provenance",
    );
  }
  const files = record(item.files, `${at}.files`);
  sameMembers(Object.keys(files), LYNX_MATRIX_RESOURCE_PATHS, `${at}.files`);
  for (const path of LYNX_MATRIX_RESOURCE_PATHS) {
    const file = record(files[path], `${at}.files.${path}`);
    hash(file.sha256, `${at}.files.${path}.sha256`);
    if (
      !Number.isSafeInteger(file.byteSize) ||
      (file.byteSize as number) <= 0
    ) {
      fail(`${at}.files.${path}.byteSize`, "expected a positive integer");
    }
  }
  return item;
}

function deltaDelivery(
  value: unknown,
  expectedBaseBundleId: string,
  expectedTarget: JsonRecord,
  at: string,
) {
  const delivery = record(value, at);
  exactString(delivery.transport, "bsdiff", `${at}.transport`);
  exactString(delivery.algorithm, "bsdiff", `${at}.algorithm`);
  string(delivery.transactionId, `${at}.transactionId`);
  exactString(
    delivery.baseBundleId,
    expectedBaseBundleId,
    `${at}.baseBundleId`,
  );
  exactString(
    delivery.targetBundleId,
    string(expectedTarget.bundleId, `${at}.expectedTarget.bundleId`),
    `${at}.targetBundleId`,
  );
  boolean(delivery.archiveFallbackUsed, false, `${at}.archiveFallbackUsed`);
  const absoluteUrl = (value: unknown, path: string) => {
    const candidate = string(value, path);
    let parsed: URL;
    try {
      parsed = new URL(candidate);
    } catch {
      return fail(path, "expected an absolute immutable artifact URL");
    }
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.hash) {
      fail(path, "expected an HTTP(S) artifact URL without a fragment");
    }
    return candidate;
  };
  if (delivery.archiveFileUrl !== null) {
    fail(`${at}.archiveFileUrl`, "expected no archive descriptor");
  }
  if (delivery.archiveFileHash !== null) {
    fail(`${at}.archiveFileHash`, "expected no archive descriptor");
  }
  absoluteUrl(delivery.deliveryArtifactUrl, `${at}.deliveryArtifactUrl`);
  absoluteUrl(delivery.manifestUrl, `${at}.manifestUrl`);
  const manifestSha256 = hash(delivery.manifestSha256, `${at}.manifestSha256`);
  if (manifestSha256 !== expectedTarget.manifestSha256) {
    fail(`${at}.manifestSha256`, "must match the target compiler manifest");
  }
  exactString(
    delivery.mainAssetPath,
    "main.lynx.bundle",
    `${at}.mainAssetPath`,
  );
  absoluteUrl(delivery.mainFileUrl, `${at}.mainFileUrl`);
  absoluteUrl(delivery.patchUrl, `${at}.patchUrl`);
  const patchSha256 = hash(delivery.patchSha256, `${at}.patchSha256`);
  const baseSha256 = hash(delivery.baseSha256, `${at}.baseSha256`);
  const targetSha256 = hash(delivery.targetSha256, `${at}.targetSha256`);
  const reconstructedSha256 = hash(
    delivery.reconstructedSha256,
    `${at}.reconstructedSha256`,
  );
  if (reconstructedSha256 !== targetSha256) {
    fail(`${at}.reconstructedSha256`, "must equal targetSha256");
  }
  exactString(
    delivery.rawDetailAssetPath,
    "detail.lynx.bundle",
    `${at}.rawDetailAssetPath`,
  );
  absoluteUrl(delivery.rawDetailFileUrl, `${at}.rawDetailFileUrl`);
  const rawDetailSha256 = hash(
    delivery.rawDetailSha256,
    `${at}.rawDetailSha256`,
  );
  const targetFiles = record(
    expectedTarget.files,
    `${at}.expectedTarget.files`,
  );
  const targetDetail = record(
    targetFiles["detail.lynx.bundle"],
    `${at}.expectedTarget.files.detail.lynx.bundle`,
  );
  if (rawDetailSha256 !== targetDetail.sha256) {
    fail(
      `${at}.rawDetailSha256`,
      "must match the target compiler detail bytes",
    );
  }
  return {
    baseSha256,
    patchSha256,
    reconstructedSha256,
    targetSha256,
  };
}

function rawDetailRejections(
  value: unknown,
  expectedTarget: JsonRecord,
  expectedRunning: JsonRecord,
  platform: LynxMatrixPlatform,
  at: string,
) {
  if (!Array.isArray(value) || value.length !== 2) {
    fail(at, "expected missing and corrupt raw-detail rejection receipts");
  }
  const modes = value.map((raw, index) => {
    const itemAt = `${at}[${index}]`;
    const item = record(raw, itemAt);
    const mode = string(item.mode, `${itemAt}.mode`);
    if (mode !== "missing" && mode !== "corrupt") {
      fail(`${itemAt}.mode`, "expected missing or corrupt");
    }
    exactString(
      item.targetBundleId,
      string(expectedTarget.bundleId, `${itemAt}.expectedTarget.bundleId`),
      `${itemAt}.targetBundleId`,
    );
    exactString(
      item.targetReleaseId,
      string(expectedTarget.releaseId, `${itemAt}.expectedTarget.releaseId`),
      `${itemAt}.targetReleaseId`,
    );
    exactString(
      item.runningBundleId,
      string(expectedRunning.bundleId, `${itemAt}.expectedRunning.bundleId`),
      `${itemAt}.runningBundleId`,
    );
    if (item.runningReleaseId !== expectedRunning.releaseId) {
      fail(`${itemAt}.runningReleaseId`, "must retain the running Release");
    }
    exactString(
      item.rawDetailAssetPath,
      "detail.lynx.bundle",
      `${itemAt}.rawDetailAssetPath`,
    );
    const rawUrl = string(item.rawDetailFileUrl, `${itemAt}.rawDetailFileUrl`);
    try {
      new URL(rawUrl);
    } catch {
      fail(`${itemAt}.rawDetailFileUrl`, "expected an immutable asset URL");
    }
    const expectedFiles = record(
      expectedTarget.files,
      `${itemAt}.target.files`,
    );
    const detail = record(
      expectedFiles["detail.lynx.bundle"],
      `${itemAt}.target.files.detail`,
    );
    exactString(
      item.expectedSha256,
      string(detail.sha256, `${itemAt}.target.detail.sha256`),
      `${itemAt}.expectedSha256`,
    );
    exactString(item.requestUrl, rawUrl, `${itemAt}.requestUrl`);
    let expectedPath: string;
    try {
      expectedPath = new URL(rawUrl).pathname;
    } catch {
      fail(`${itemAt}.rawDetailFileUrl`, "expected an immutable asset URL");
    }
    exactString(item.requestPath, expectedPath, `${itemAt}.requestPath`);
    const requestCountBefore = item.requestCountBefore;
    const requestCountAfter = item.requestCountAfter;
    const consumedRequestCount = item.consumedRequestCount;
    for (const [name, observed] of [
      ["requestCountBefore", requestCountBefore],
      ["requestCountAfter", requestCountAfter],
      ["consumedRequestCount", consumedRequestCount],
    ] as const) {
      if (!Number.isInteger(observed) || Number(observed) < 0) {
        fail(`${itemAt}.${name}`, "expected a non-negative integer");
      }
    }
    if (Number(consumedRequestCount) < 1) {
      fail(`${itemAt}.consumedRequestCount`, "expected a consumed request");
    }
    if (
      Number(requestCountAfter) !==
      Number(requestCountBefore) + Number(consumedRequestCount)
    ) {
      fail(
        `${itemAt}.requestCountAfter`,
        "does not bind the consumed requests",
      );
    }
    hash(item.responseSha256, `${itemAt}.responseSha256`);
    const expectedFailure = expectedRawDetailNativeFailure(platform, mode);
    exactString(
      item.nativeInstallErrorCode,
      expectedFailure.code,
      `${itemAt}.nativeInstallErrorCode`,
    );
    exactString(
      item.nativeInstallErrorMessage,
      expectedFailure.message,
      `${itemAt}.nativeInstallErrorMessage`,
    );
    exactString(
      item.nativeInstallErrorTransport,
      "matrix-control-http",
      `${itemAt}.nativeInstallErrorTransport`,
    );
    const receivedAt = string(
      item.nativeInstallErrorReceivedAt,
      `${itemAt}.nativeInstallErrorReceivedAt`,
    );
    if (!Number.isFinite(Date.parse(receivedAt))) {
      fail(
        `${itemAt}.nativeInstallErrorReceivedAt`,
        "expected the persisted control receipt timestamp",
      );
    }
    const nativeInstallError = string(
      item.nativeInstallError,
      `${itemAt}.nativeInstallError`,
    );
    exactString(
      nativeInstallError,
      `Installation failed: [${expectedFailure.code}] ${expectedFailure.message}`,
      `${itemAt}.nativeInstallError`,
    );
    if (mode === "corrupt") {
      const actual = hash(
        item.actualAssetSha256,
        `${itemAt}.actualAssetSha256`,
      );
      if (actual === item.expectedSha256 || actual !== item.responseSha256) {
        fail(
          `${itemAt}.actualAssetSha256`,
          "must bind the mismatched bytes returned by the asset request",
        );
      }
      if (item.responseStatus !== 200 || item.responseErrorCode !== null) {
        fail(
          `${itemAt}.responseStatus`,
          "expected a corrupt HTTP 200 response",
        );
      }
    } else {
      if (item.actualAssetSha256 !== null) {
        fail(`${itemAt}.actualAssetSha256`, "expected no missing asset bytes");
      }
      if (
        item.responseStatus !== 404 ||
        item.responseErrorCode !== "HTTP_404"
      ) {
        fail(
          `${itemAt}.responseStatus`,
          "expected an observed HTTP_404 response",
        );
      }
      exactString(
        item.responseSha256,
        MISSING_ASSET_RESPONSE_SHA256,
        `${itemAt}.responseSha256`,
      );
    }
    if (item.archiveFileUrl !== null || item.archiveFileHash !== null) {
      fail(`${itemAt}.archiveFileUrl`, "expected no archive descriptor");
    }
    boolean(item.archiveFallbackUsed, false, `${itemAt}.archiveFallbackUsed`);
    boolean(
      item.rejectedBeforeTransition,
      true,
      `${itemAt}.rejectedBeforeTransition`,
    );
    string(item.processId, `${itemAt}.processId`);
    const generationId = string(item.generationId, `${itemAt}.generationId`);
    exactString(
      item.generationIdAfter,
      generationId,
      `${itemAt}.generationIdAfter`,
    );
    exactString(
      item.bundleIdAfter,
      string(expectedRunning.bundleId, `${itemAt}.expectedRunning.bundleId`),
      `${itemAt}.bundleIdAfter`,
    );
    if (item.releaseIdAfter !== expectedRunning.releaseId) {
      fail(`${itemAt}.releaseIdAfter`, "must retain the running Release");
    }
    if (
      item.fallbackMarkerCountBefore !== item.fallbackMarkerCountAfter ||
      !Number.isInteger(item.fallbackMarkerCountBefore)
    ) {
      fail(
        `${itemAt}.fallbackMarkerCountAfter`,
        "archive fallback was observed",
      );
    }
    return mode;
  });
  sameMembers(modes, ["missing", "corrupt"], `${at}.modes`);
}

function navigationBoundaryParameters(vector: string) {
  if (vector === "canonical-options") {
    return { title: "Second Page", value: "a+b" };
  }
  if (vector === "parameter-count") {
    return Object.fromEntries(
      Array.from({ length: 32 }, (_, index) => [`p${index}`, String(index)]),
    );
  }
  if (vector === "key-bytes") return { ["é".repeat(64)]: "ok" };
  if (vector === "value-bytes") return { value: "é".repeat(512) };
  if (vector === "decoded-query-bytes") {
    return { a: "a".repeat(1_024), b: "b".repeat(998) };
  }
  return { a: "é".repeat(512), b: "b".repeat(970) };
}

function navigationBoundaries(
  value: unknown,
  platform: string,
  mainContextId: string,
  at: string,
) {
  const vectors = [
    "canonical-options",
    "parameter-count",
    "key-bytes",
    "value-bytes",
    "decoded-query-bytes",
    "raw-route-bytes",
  ];
  if (!Array.isArray(value) || value.length !== vectors.length) {
    fail(at, "expected all six navigation boundary vectors");
  }
  const contexts = value.map((raw, index) => {
    const itemAt = `${at}[${index}]`;
    const item = record(raw, itemAt);
    exactString(item.vector, vectors[index]!, `${itemAt}.vector`);
    exactString(
      item.sourceContextId,
      mainContextId,
      `${itemAt}.sourceContextId`,
    );
    if (
      JSON.stringify(item.parameters) !==
      JSON.stringify(navigationBoundaryParameters(vectors[index]!))
    ) {
      fail(`${itemAt}.parameters`, "did not preserve exact decoded parameters");
    }
    const nativePageClass = string(
      item.nativePageClass,
      `${itemAt}.nativePageClass`,
    );
    if (
      (platform === "ios" && !nativePageClass.includes("SPKViewController")) ||
      (platform === "android" &&
        !nativePageClass.endsWith("HotUpdaterSparklingPageActivity"))
    ) {
      fail(
        `${itemAt}.nativePageClass`,
        "expected the managed native page class",
      );
    }
    if (item.acceptedOpenCount !== 1 || item.overflowNativeOpenCount !== 0) {
      fail(itemAt, "overflow reached the native open boundary");
    }
    boolean(item.closedToMain, true, `${itemAt}.closedToMain`);
    return string(item.acceptedContextId, `${itemAt}.acceptedContextId`);
  });
  if (new Set(contexts).size !== contexts.length) {
    fail(at, "accepted pages must use distinct managed contexts");
  }
}

function recovery(
  value: unknown,
  kind: "confirmed-interruption" | "fatal" | "unconfirmed",
  candidateBuild: JsonRecord,
  stableBuild: JsonRecord,
  at: string,
) {
  const item = record(value, at);
  exactString(item.kind, kind, `${at}.kind`);
  const candidate = selection(item.candidate, `${at}.candidate`);
  if (
    candidate.bundleId === stableBuild.bundleId ||
    candidate.releaseId === stableBuild.releaseId
  ) {
    fail(`${at}.candidate`, "failed candidate must differ from stable release");
  }
  const failedAttemptId = string(item.failedAttemptId, `${at}.failedAttemptId`);
  const failureEvent = identity(item.failureEvent, `${at}.failureEvent`);
  if (
    failureEvent.attemptId !== failedAttemptId ||
    failureEvent.bundleId !== candidate.bundleId ||
    failureEvent.releaseId !== candidate.releaseId
  ) {
    fail(`${at}.failureEvent`, "must identify the failed candidate attempt");
  }
  const candidateLaunch =
    kind === "fatal"
      ? fatalPendingLaunch(
          item.candidateLaunch,
          candidateBuild,
          `${at}.candidateLaunch`,
          candidate,
          false,
        )
      : unconfirmedLaunch(
          item.candidateLaunch,
          candidateBuild,
          `${at}.candidateLaunch`,
          candidate,
          kind === "confirmed-interruption",
        );
  if (
    failureEvent.runtimeId !== candidateLaunch.identity.runtimeId ||
    failureEvent.processId !== candidateLaunch.identity.processId ||
    failureEvent.generationId !== candidateLaunch.identity.generationId ||
    failureEvent.attemptId !== candidateLaunch.identity.attemptId ||
    !candidateLaunch.contextIds.includes(failureEvent.contextId)
  ) {
    fail(`${at}.failureEvent`, "must belong to the candidate generation");
  }
  if (kind === "confirmed-interruption") {
    nativeConfirmation(
      candidateLaunch.confirmation,
      "CONFIRMED",
      {
        kind: "UPDATE_APPLIED",
        from: {
          bundleId: string(stableBuild.bundleId, "stableBuild.bundleId"),
          releaseId: nullableString(
            stableBuild.releaseId,
            "stableBuild.releaseId",
          ),
        },
        to: candidate,
      },
      `${at}.candidateLaunch.confirmation`,
    );
  }
  if (kind === "fatal") {
    exactString(
      item.failureEvent.event,
      "runtimeFailed",
      `${at}.failureEvent.event`,
    );
    const runtimeFailedSequence = sequence(
      item.failureEvent.runtimeFailedSequence,
      `${at}.failureEvent.runtimeFailedSequence`,
    );
    const generationFailedSequence = sequence(
      item.failureEvent.generationFailedSequence,
      `${at}.failureEvent.generationFailedSequence`,
    );
    const pageAttemptTerminalSequence = sequence(
      item.failureEvent.pageAttemptTerminalSequence,
      `${at}.failureEvent.pageAttemptTerminalSequence`,
    );
    if (
      runtimeFailedSequence >= pageAttemptTerminalSequence ||
      pageAttemptTerminalSequence >= generationFailedSequence
    ) {
      fail(
        `${at}.failureEvent`,
        "runtimeFailed, verified-fatal terminal, and generationFailed are out of order",
      );
    }
    const terminal = record(
      item.failureEvent.pageAttemptTerminal,
      `${at}.failureEvent.pageAttemptTerminal`,
    );
    const terminalIdentity = identity(
      terminal,
      `${at}.failureEvent.pageAttemptTerminal`,
    );
    if (JSON.stringify(terminalIdentity) !== JSON.stringify(failureEvent)) {
      fail(
        `${at}.failureEvent.pageAttemptTerminal`,
        "must match the failed detail identity",
      );
    }
    exactString(
      terminal.terminal,
      "verified-fatal",
      `${at}.failureEvent.pageAttemptTerminal.terminal`,
    );
    string(
      terminal.pageAttemptId,
      `${at}.failureEvent.pageAttemptTerminal.pageAttemptId`,
    );
    if (
      failureEvent.runtimeId !== candidateLaunch.identity.runtimeId ||
      failureEvent.processId !== candidateLaunch.identity.processId ||
      failureEvent.generationId !== candidateLaunch.identity.generationId ||
      failureEvent.attemptId !== candidateLaunch.identity.attemptId ||
      failureEvent.contextId === candidateLaunch.identity.contextId ||
      !candidateLaunch.contextIds.includes(failureEvent.contextId)
    ) {
      fail(
        `${at}.failureEvent`,
        "must be attributed to the managed secondary candidate context",
      );
    }
    generationRetirement(
      item.generationRetirement,
      candidateLaunch,
      `${at}.generationRetirement`,
      false,
    );
  } else {
    exactString(
      item.failureEvent.event,
      "pageAttemptTerminal",
      `${at}.failureEvent.event`,
    );
    exactString(
      item.failureEvent.terminal,
      "process-interruption",
      `${at}.failureEvent.terminal`,
    );
    string(item.failureEvent.pageAttemptId, `${at}.failureEvent.pageAttemptId`);
    sequence(
      item.failureEvent.terminalSequence,
      `${at}.failureEvent.terminalSequence`,
    );
    if (failureEvent.contextId === candidateLaunch.identity.contextId) {
      fail(
        `${at}.failureEvent.contextId`,
        "process interruption must identify the pending detail context",
      );
    }
    const pendingMember = candidateLaunch.members.find(
      (member) => member.primary !== true,
    );
    if (
      !pendingMember ||
      record(pendingMember, `${at}.candidateLaunch.members`).pageAttemptId !==
        item.failureEvent.pageAttemptId
    ) {
      fail(
        `${at}.failureEvent.pageAttemptId`,
        "must match the pending detail attempt",
      );
    }
  }
  const recovered = readyLaunch(item.recovered, stableBuild, `${at}.recovered`);
  if (
    kind !== "fatal" &&
    sequence(
      item.failureEvent.terminalSequence,
      `${at}.failureEvent.terminalSequence`,
    ) >=
      sequence(
        record(item.recovered, `${at}.recovered`).evaluationSequence,
        `${at}.recovered.evaluationSequence`,
      )
  ) {
    fail(
      `${at}.recovered.evaluationSequence`,
      "recovery evaluation must follow the durable process interruption",
    );
  }
  nativeConfirmation(
    recovered.confirmation,
    "ALREADY_CONFIRMED",
    {
      kind: "RECOVERED",
      from: candidate,
      to: {
        bundleId: string(stableBuild.bundleId, "stableBuild.bundleId"),
        releaseId: nullableString(
          stableBuild.releaseId,
          "stableBuild.releaseId",
        ),
      },
    },
    `${at}.recovered.confirmation`,
  );
  if (kind === "fatal") {
    if (
      recovered.identity.processId !== candidateLaunch.identity.processId ||
      recovered.identity.generationId ===
        candidateLaunch.identity.generationId ||
      candidateLaunch.contextIds.some((contextId) =>
        recovered.contextIds.includes(contextId),
      )
    ) {
      fail(
        `${at}.recovered`,
        "must replace the complete fatal generation in the same OS process",
      );
    }
  } else if (
    recovered.identity.processId === candidateLaunch.identity.processId
  ) {
    fail(`${at}.recovered`, "unconfirmed recovery must follow an OS relaunch");
  }
  const excluded = stringArray(
    item.persistedExclusions,
    `${at}.persistedExclusions`,
  );
  const excludedId =
    kind === "fatal" ? candidate.bundleId : candidate.releaseId;
  if (!excluded.includes(excludedId)) {
    fail(`${at}.persistedExclusions`, `must contain ${excludedId}`);
  }
  if (kind === "confirmed-interruption") {
    const crashedBundleIds = stringArray(
      item.crashedBundleIds,
      `${at}.crashedBundleIds`,
    );
    if (crashedBundleIds.includes(candidate.bundleId)) {
      fail(
        `${at}.crashedBundleIds`,
        "process interruption must not enter verified Bundle crash history",
      );
    }
  }
  boolean(item.candidateRetried, false, `${at}.candidateRetried`);
  return recovered;
}

export function validateLynxMatrixCell(value: unknown): void {
  const cell = record(value, "cell");
  exactString(
    cell.schemaVersion,
    "lynx-public-matrix-v2",
    "cell.schemaVersion",
  );
  const framework = string(cell.framework, "cell.framework");
  const platform = string(cell.platform, "cell.platform");
  if (!LYNX_MATRIX_FRAMEWORKS.includes(framework as never)) {
    fail("cell.framework", "expected react, vue, or octane");
  }
  if (!LYNX_MATRIX_PLATFORMS.includes(platform as never)) {
    fail("cell.platform", "expected ios or android");
  }
  exactString(cell.cellId, `${framework}-${platform}`, "cell.cellId");
  const commit = string(cell.commit, "cell.commit");
  if (!/^[a-f0-9]{40}$/.test(commit)) {
    fail("cell.commit", "expected a full Git commit");
  }
  const nativeArtifacts = validateLynxNativeArtifactsReceipt(
    cell.nativeArtifacts,
    {
      appId: "com.hotupdater.lynxmatrix",
      commit,
      platforms: [platform as LynxMatrixPlatform],
      target: "matrix",
    },
  );
  const nativeArtifact = record(
    record(nativeArtifacts.artifacts, "cell.nativeArtifacts.artifacts")[
      platform
    ],
    `cell.nativeArtifacts.artifacts.${platform}`,
  );
  const binary = record(cell.binary, "cell.binary");
  string(binary.path, "cell.binary.path");
  const installedHash = hash(
    binary.installedSha256,
    "cell.binary.installedSha256",
  );
  const finalHash = hash(binary.finalSha256, "cell.binary.finalSha256");
  if (installedHash !== finalHash) {
    fail(
      "cell.binary.finalSha256",
      "native binary changed during the scenario",
    );
  }
  exactString(
    installedHash,
    hash(
      nativeArtifact.binarySha256,
      `cell.nativeArtifacts.artifacts.${platform}.binarySha256`,
    ),
    "cell.binary.installedSha256",
  );

  const builds = record(cell.builds, "cell.builds");
  const a = build(builds.A, "A", "cell.builds.A", true);
  if (a.releaseId !== null) {
    fail("cell.builds.A.releaseId", "embedded BUILTIN releaseId must be null");
  }
  const serverA = build(builds.serverA, "A", "cell.builds.serverA");
  if (
    serverA.bundleId !== a.bundleId ||
    serverA.manifestSha256 !== a.manifestSha256 ||
    JSON.stringify(serverA.files) !== JSON.stringify(a.files)
  ) {
    fail(
      "cell.builds.serverA",
      "must register the exact embedded compiler Bundle A with a server Release",
    );
  }
  const b = build(builds.B, "B", "cell.builds.B");
  const c = build(builds.C, "C", "cell.builds.C");
  const confirmedInterruption = build(
    builds.confirmedInterruption,
    "CONFIRMED_INTERRUPTION",
    "cell.builds.confirmedInterruption",
  );
  const fatal = build(builds.fatal, "FATAL", "cell.builds.fatal");
  const unconfirmed = build(
    builds.unconfirmed,
    "UNCONFIRMED",
    "cell.builds.unconfirmed",
  );
  const runtimeIds = [
    a,
    serverA,
    b,
    c,
    confirmedInterruption,
    fatal,
    unconfirmed,
  ].map((item) => item.runtimeId);
  if (new Set(runtimeIds).size !== 1) {
    fail("cell.builds", "all artifacts must use the same runtimeId");
  }
  exactString(
    runtimeIds[0],
    string(
      nativeArtifact.runtimeId,
      `cell.nativeArtifacts.artifacts.${platform}.runtimeId`,
    ),
    "cell.builds.A.runtimeId",
  );
  if (
    new Set([
      c.bundleId,
      confirmedInterruption.bundleId,
      fatal.bundleId,
      unconfirmed.bundleId,
    ]).size !== 4 ||
    new Set([
      c.releaseId,
      confirmedInterruption.releaseId,
      fatal.releaseId,
      unconfirmed.releaseId,
    ]).size !== 4
  ) {
    fail(
      "cell.builds",
      "C and every recovery candidate must have distinct real identities",
    );
  }

  const diagnostics = record(cell.diagnostics, "cell.diagnostics");
  const diagnosticsProcessId = string(
    record(
      record(
        record(cell.phases, "cell.phases").embeddedA,
        "cell.phases.embeddedA",
      ).identity,
      "cell.phases.embeddedA.identity",
    ).processId,
    "cell.phases.embeddedA.identity.processId",
  );
  for (const name of [
    "navigationStackBoundary",
    "runtimeEventFieldBoundaries",
    "runtimeJournalFixtures",
  ]) {
    exactString(
      record(diagnostics[name], `cell.diagnostics.${name}`).processId,
      diagnosticsProcessId,
      `cell.diagnostics.${name}.processId`,
    );
  }
  if (
    !Array.isArray(diagnostics.managedResourceEngineErrorCodes) ||
    diagnostics.managedResourceEngineErrorCodes.length !== 0
  ) {
    fail(
      "cell.diagnostics.managedResourceEngineErrorCodes",
      "expected no managed-resource engine codes",
    );
  }
  try {
    validateNavigationStackBoundary(diagnostics.navigationStackBoundary);
    validateRuntimeEventFieldBoundaryDiagnostics(
      diagnostics.runtimeEventFieldBoundaries,
    );
    validateMatrixRuntimeJournalDiagnostics(diagnostics.runtimeJournalFixtures);
  } catch (error) {
    fail(
      "cell.diagnostics",
      error instanceof Error ? error.message : String(error),
    );
  }
  const ledger = record(
    diagnostics.runtimeEventLedger,
    "cell.diagnostics.runtimeEventLedger",
  );
  exactString(
    ledger.schemaVersion,
    "lynx-generation-event-ledger-v1",
    "cell.diagnostics.runtimeEventLedger.schemaVersion",
  );
  exactString(
    ledger.oldestSequence,
    "1",
    "cell.diagnostics.runtimeEventLedger.oldestSequence",
  );
  const ledgerLatest = string(
    ledger.latestSequence,
    "cell.diagnostics.runtimeEventLedger.latestSequence",
  );
  if (!/^[1-9][0-9]*$/.test(ledgerLatest)) {
    fail(
      "cell.diagnostics.runtimeEventLedger.latestSequence",
      "expected a canonical decimal sequence",
    );
  }
  if (
    !Number.isSafeInteger(ledger.eventCount) ||
    BigInt(ledger.eventCount as number) !== BigInt(ledgerLatest)
  ) {
    fail(
      "cell.diagnostics.runtimeEventLedger.eventCount",
      "must prove contiguous external coverage from sequence 1",
    );
  }
  const ledgerHash = hash(
    ledger.sha256,
    "cell.diagnostics.runtimeEventLedger.sha256",
  );
  if (!Array.isArray(ledger.checkpoints) || ledger.checkpoints.length < 8) {
    fail(
      "cell.diagnostics.runtimeEventLedger.checkpoints",
      "expected package snapshots after every matrix lifecycle phase",
    );
  }
  let priorLatest: bigint | null = null;
  for (const [index, rawCheckpoint] of ledger.checkpoints.entries()) {
    const checkpointAt = `cell.diagnostics.runtimeEventLedger.checkpoints[${index}]`;
    const checkpoint = record(rawCheckpoint, checkpointAt);
    string(checkpoint.stage, `${checkpointAt}.stage`);
    const oldest = string(
      checkpoint.oldestSequence,
      `${checkpointAt}.oldestSequence`,
    );
    const latest = string(
      checkpoint.latestSequence,
      `${checkpointAt}.latestSequence`,
    );
    if (!/^[1-9][0-9]*$/.test(oldest) || !/^[1-9][0-9]*$/.test(latest)) {
      fail(checkpointAt, "expected canonical decimal sequence bounds");
    }
    const truncated = checkpoint.truncated;
    if (typeof truncated !== "boolean") {
      fail(`${checkpointAt}.truncated`, "expected a boolean");
    }
    if (
      truncated === true &&
      (priorLatest === null || BigInt(oldest) > priorLatest + 1n)
    ) {
      fail(checkpointAt, "truncation may have hidden required native evidence");
    }
    hash(checkpoint.snapshotSha256, `${checkpointAt}.snapshotSha256`);
    hash(checkpoint.ledgerSha256, `${checkpointAt}.ledgerSha256`);
    priorLatest = BigInt(latest);
  }
  const finalCheckpoint = record(
    ledger.checkpoints.at(-1),
    "cell.diagnostics.runtimeEventLedger.checkpoints[last]",
  );
  exactString(
    finalCheckpoint.latestSequence,
    ledgerLatest,
    "cell.diagnostics.runtimeEventLedger.checkpoints[last].latestSequence",
  );
  exactString(
    finalCheckpoint.ledgerSha256,
    ledgerHash,
    "cell.diagnostics.runtimeEventLedger.checkpoints[last].ledgerSha256",
  );

  const phases = record(cell.phases, "cell.phases");
  const embeddedA = readyLaunch(phases.embeddedA, a, "cell.phases.embeddedA");
  nativeConfirmation(
    embeddedA.confirmation,
    "CONFIRMED",
    null,
    "cell.phases.embeddedA.confirmation",
  );
  navigationBoundaries(
    phases.navigationBoundaries,
    platform,
    embeddedA.identity.contextId,
    "cell.phases.navigationBoundaries",
  );
  const deltaB = record(phases.deltaB, "cell.phases.deltaB");
  deltaDelivery(
    deltaB.delivery,
    string(a.bundleId, "cell.builds.A.bundleId"),
    b,
    "cell.phases.deltaB.delivery",
  );
  rawDetailRejections(
    deltaB.rawDetailRejections,
    b,
    a,
    platform,
    "cell.phases.deltaB.rawDetailRejections",
  );
  const stagedB = selection(
    deltaB.stagedSelection,
    "cell.phases.deltaB.stagedSelection",
  );
  if (stagedB.bundleId !== b.bundleId || stagedB.releaseId !== b.releaseId) {
    fail("cell.phases.deltaB.stagedSelection", "must identify build B");
  }

  const offline = record(phases.offline, "cell.phases.offline");
  const probe = record(offline.originProbe, "cell.phases.offline.originProbe");
  exactString(
    probe.outcome,
    "connection-refused",
    "cell.phases.offline.originProbe.outcome",
  );
  string(probe.url, "cell.phases.offline.originProbe.url");
  string(probe.observedAt, "cell.phases.offline.originProbe.observedAt");
  const activation = readyLaunch(
    offline.activationB,
    b,
    "cell.phases.offline.activationB",
    stagedB,
  );
  const retain = readyLaunch(
    offline.retainB,
    b,
    "cell.phases.offline.retainB",
    stagedB,
  );
  nativeConfirmation(
    activation.confirmation,
    "CONFIRMED",
    {
      kind: "UPDATE_APPLIED",
      from: {
        bundleId: string(a.bundleId, "cell.builds.A.bundleId"),
        releaseId: nullableString(a.releaseId, "cell.builds.A.releaseId"),
      },
      to: stagedB,
    },
    "cell.phases.offline.activationB.confirmation",
  );
  nativeConfirmation(
    retain.confirmation,
    "ALREADY_CONFIRMED",
    null,
    "cell.phases.offline.retainB.confirmation",
  );
  if (activation.identity.processId === retain.identity.processId) {
    fail("cell.phases.offline", "B retain must be a later OS process");
  }
  boolean(
    offline.originStayedDown,
    true,
    "cell.phases.offline.originStayedDown",
  );

  const delta = record(phases.deltaC, "cell.phases.deltaC");
  deltaDelivery(
    delta.delivery,
    string(b.bundleId, "cell.builds.B.bundleId"),
    c,
    "cell.phases.deltaC.delivery",
  );
  rawDetailRejections(
    delta.rawDetailRejections,
    c,
    b,
    platform,
    "cell.phases.deltaC.rawDetailRejections",
  );
  const before = readyLaunch(
    delta.beforeReload,
    b,
    "cell.phases.deltaC.beforeReload",
    stagedB,
  );
  const after = readyLaunch(
    delta.afterReload,
    c,
    "cell.phases.deltaC.afterReload",
  );
  if (
    before.reconstructedStack !== false ||
    after.reconstructedStack !== true
  ) {
    fail(
      "cell.phases.deltaC",
      "B detail must stay open and be reconstructed by the C generation",
    );
  }
  nativeConfirmation(
    after.confirmation,
    "CONFIRMED",
    {
      kind: "UPDATE_APPLIED",
      from: {
        bundleId: string(b.bundleId, "cell.builds.B.bundleId"),
        releaseId: nullableString(b.releaseId, "cell.builds.B.releaseId"),
      },
      to: {
        bundleId: string(c.bundleId, "cell.builds.C.bundleId"),
        releaseId: nullableString(c.releaseId, "cell.builds.C.releaseId"),
      },
    },
    "cell.phases.deltaC.afterReload.confirmation",
  );
  if (before.identity.processId !== after.identity.processId) {
    fail("cell.phases.deltaC", "HotUpdater.reload() changed the OS process");
  }
  if (before.identity.generationId === after.identity.generationId) {
    fail(
      "cell.phases.deltaC",
      "HotUpdater.reload() reused the managed generation",
    );
  }
  if (
    before.contextIds.some((contextId) => after.contextIds.includes(contextId))
  ) {
    fail(
      "cell.phases.deltaC.afterReload.contextIds",
      "fresh generation must replace every primary and secondary context ID",
    );
  }
  if (before.resources.some((resource) => resource.leaseReleased !== true)) {
    fail(
      "cell.phases.deltaC.beforeReload.resources",
      "all old-generation resource leases must drain during reload",
    );
  }
  generationRetirement(
    delta.generationRetirement,
    before,
    "cell.phases.deltaC.generationRetirement",
    true,
  );
  const crossProvenance = record(
    phases.crossProvenance,
    "cell.phases.crossProvenance",
  );
  const incompatible = build(
    crossProvenance.build,
    "INCOMPATIBLE",
    "cell.phases.crossProvenance.build",
  );
  exactString(
    incompatible.runtimeId,
    LYNX_MATRIX_INCOMPATIBLE_RUNTIME_IDS[platform as LynxMatrixPlatform],
    "cell.phases.crossProvenance.build.runtimeId",
  );
  const provenanceRejection = record(
    crossProvenance.rejection,
    "cell.phases.crossProvenance.rejection",
  );
  const rejectedCandidate = record(
    provenanceRejection.candidate,
    "cell.phases.crossProvenance.rejection.candidate",
  );
  for (const key of ["bundleId", "releaseId", "runtimeId"]) {
    exactString(
      rejectedCandidate[key],
      string(incompatible[key], `cell.phases.crossProvenance.build.${key}`),
      `cell.phases.crossProvenance.rejection.candidate.${key}`,
    );
  }
  exactString(
    rejectedCandidate.manifestSha256,
    hash(
      incompatible.manifestSha256,
      "cell.phases.crossProvenance.build.manifestSha256",
    ),
    "cell.phases.crossProvenance.rejection.candidate.manifestSha256",
  );
  absoluteUrl(
    rejectedCandidate.artifactUrl,
    "cell.phases.crossProvenance.rejection.candidate.artifactUrl",
  );
  const provenanceRunning = record(
    provenanceRejection.running,
    "cell.phases.crossProvenance.rejection.running",
  );
  exactString(
    provenanceRunning.bundleId,
    string(c.bundleId, "cell.builds.C.bundleId"),
    "cell.phases.crossProvenance.rejection.running.bundleId",
  );
  exactString(
    provenanceRunning.releaseId,
    string(c.releaseId, "cell.builds.C.releaseId"),
    "cell.phases.crossProvenance.rejection.running.releaseId",
  );
  exactString(
    provenanceRunning.runtimeId,
    string(c.runtimeId, "cell.builds.C.runtimeId"),
    "cell.phases.crossProvenance.rejection.running.runtimeId",
  );
  const provenanceProcessId = string(
    provenanceRunning.processId,
    "cell.phases.crossProvenance.rejection.running.processId",
  );
  if (!/^[1-9][0-9]*$/.test(provenanceProcessId)) {
    fail(
      "cell.phases.crossProvenance.rejection.running.processId",
      "expected a canonical positive decimal process ID",
    );
  }
  exactString(
    provenanceProcessId,
    after.identity.processId,
    "cell.phases.crossProvenance.rejection.running.processId",
  );
  exactString(
    provenanceRunning.generationId,
    after.identity.generationId,
    "cell.phases.crossProvenance.rejection.running.generationId",
  );
  exactString(
    provenanceRejection.nativeErrorCode,
    "INCOMPATIBLE",
    "cell.phases.crossProvenance.rejection.nativeErrorCode",
  );
  boolean(
    provenanceRejection.rejectedBeforeGenerationEvaluation,
    true,
    "cell.phases.crossProvenance.rejection.rejectedBeforeGenerationEvaluation",
  );
  if (
    provenanceRejection.firstArtifactRequestCount !== 1 ||
    provenanceRejection.cachedArtifactRequestCount !== 0
  ) {
    fail(
      "cell.phases.crossProvenance.rejection",
      "expected one initial artifact request and no cached redownload",
    );
  }
  const primaryLifecycle = record(
    phases.primaryLifecycle,
    "cell.phases.primaryLifecycle",
  );
  const beforePrimaryRemoval = readyLaunch(
    primaryLifecycle.beforeRemoval,
    c,
    "cell.phases.primaryLifecycle.beforeRemoval",
  );
  if (
    JSON.stringify(beforePrimaryRemoval.identity) !==
      JSON.stringify(after.identity) ||
    JSON.stringify(beforePrimaryRemoval.contextIds) !==
      JSON.stringify(after.contextIds)
  ) {
    fail(
      "cell.phases.primaryLifecycle.beforeRemoval",
      "must be the live generation produced by the B to C reload",
    );
  }
  generationRetirement(
    primaryLifecycle.generationRetirement,
    beforePrimaryRemoval,
    "cell.phases.primaryLifecycle.generationRetirement",
    true,
  );
  const afterPrimaryReplacement = readyLaunch(
    primaryLifecycle.afterReplacement,
    c,
    "cell.phases.primaryLifecycle.afterReplacement",
  );
  nativeConfirmation(
    afterPrimaryReplacement.confirmation,
    "ALREADY_CONFIRMED",
    null,
    "cell.phases.primaryLifecycle.afterReplacement.confirmation",
  );
  if (
    afterPrimaryReplacement.identity.processId !==
      beforePrimaryRemoval.identity.processId ||
    afterPrimaryReplacement.identity.generationId ===
      beforePrimaryRemoval.identity.generationId ||
    beforePrimaryRemoval.contextIds.some((contextId) =>
      afterPrimaryReplacement.contextIds.includes(contextId),
    )
  ) {
    fail(
      "cell.phases.primaryLifecycle.afterReplacement",
      "must recreate a fresh primary and secondary in the same process",
    );
  }
  const pendingTransition = record(
    phases.pendingManagedTransition,
    "cell.phases.pendingManagedTransition",
  );
  const pendingBefore = readyLaunch(
    pendingTransition.before,
    c,
    "cell.phases.pendingManagedTransition.before",
  );
  const pendingAfter = readyLaunch(
    pendingTransition.after,
    c,
    "cell.phases.pendingManagedTransition.after",
  );
  if (
    JSON.stringify(pendingBefore.identity) !==
      JSON.stringify(afterPrimaryReplacement.identity) ||
    pendingBefore.identity.processId !== pendingAfter.identity.processId ||
    pendingBefore.identity.generationId ===
      pendingAfter.identity.generationId ||
    pendingAfter.reconstructedStack !== true
  ) {
    fail(
      "cell.phases.pendingManagedTransition",
      "must reconstruct the pending stack in a fresh same-process generation",
    );
  }
  const pendingReceipt = record(
    pendingTransition.receipt,
    "cell.phases.pendingManagedTransition.receipt",
  );
  exactString(
    pendingReceipt.processId,
    pendingBefore.identity.processId,
    "cell.phases.pendingManagedTransition.receipt.processId",
  );
  exactString(
    pendingReceipt.bundleId,
    string(c.bundleId, "cell.builds.C.bundleId"),
    "cell.phases.pendingManagedTransition.receipt.bundleId",
  );
  if (pendingReceipt.releaseId !== c.releaseId) {
    fail(
      "cell.phases.pendingManagedTransition.receipt.releaseId",
      "must retain Release C",
    );
  }
  exactString(
    pendingReceipt.sourceGenerationId,
    pendingBefore.identity.generationId,
    "cell.phases.pendingManagedTransition.receipt.sourceGenerationId",
  );
  exactString(
    pendingReceipt.targetGenerationId,
    pendingAfter.identity.generationId,
    "cell.phases.pendingManagedTransition.receipt.targetGenerationId",
  );
  exactString(
    pendingReceipt.terminal,
    "authorized-cancel",
    "cell.phases.pendingManagedTransition.receipt.terminal",
  );
  exactString(
    pendingReceipt.reason,
    "managedTransition",
    "cell.phases.pendingManagedTransition.receipt.reason",
  );
  string(
    pendingReceipt.transitionId,
    "cell.phases.pendingManagedTransition.receipt.transitionId",
  );
  const pendingAttemptId = string(
    pendingReceipt.pendingPageAttemptId,
    "cell.phases.pendingManagedTransition.receipt.pendingPageAttemptId",
  );
  if (
    string(
      pendingReceipt.reconstructedPageAttemptId,
      "cell.phases.pendingManagedTransition.receipt.reconstructedPageAttemptId",
    ) === pendingAttemptId
  ) {
    fail(
      "cell.phases.pendingManagedTransition.receipt.reconstructedPageAttemptId",
      "must use a fresh page attempt",
    );
  }
  if (
    JSON.stringify(pendingReceipt.orderedPageEntries) !==
      JSON.stringify(["main.lynx.bundle", "detail.lynx.bundle"]) ||
    pendingReceipt.topPageEntry !== "detail.lynx.bundle"
  ) {
    fail(
      "cell.phases.pendingManagedTransition.receipt",
      "must retain the ordered main/detail stack",
    );
  }
  const confirmedFatal = record(
    phases.confirmedDetailFatal,
    "cell.phases.confirmedDetailFatal",
  );
  const beforeConfirmedFatal = fatalPendingLaunch(
    confirmedFatal.beforeFailure,
    c,
    "cell.phases.confirmedDetailFatal.beforeFailure",
    {
      bundleId: string(c.bundleId, "cell.builds.C.bundleId"),
      releaseId: nullableString(c.releaseId, "cell.builds.C.releaseId"),
    },
    true,
  );
  if (
    JSON.stringify(beforeConfirmedFatal.identity) !==
      JSON.stringify(pendingAfter.identity) ||
    beforeConfirmedFatal.contextIds[0] !== pendingAfter.identity.contextId
  ) {
    fail(
      "cell.phases.confirmedDetailFatal.beforeFailure",
      "must be the confirmed post-pending-transition generation",
    );
  }
  const confirmedFailure = identity(
    confirmedFatal.failureEvent,
    "cell.phases.confirmedDetailFatal.failureEvent",
  );
  exactString(
    record(
      confirmedFatal.failureEvent,
      "cell.phases.confirmedDetailFatal.failureEvent",
    ).event,
    "runtimeFailed",
    "cell.phases.confirmedDetailFatal.failureEvent.event",
  );
  const confirmedRuntimeFailedSequence = sequence(
    confirmedFatal.failureEvent.runtimeFailedSequence,
    "cell.phases.confirmedDetailFatal.failureEvent.runtimeFailedSequence",
  );
  const confirmedTerminalSequence = sequence(
    confirmedFatal.failureEvent.pageAttemptTerminalSequence,
    "cell.phases.confirmedDetailFatal.failureEvent.pageAttemptTerminalSequence",
  );
  const confirmedGenerationFailedSequence = sequence(
    confirmedFatal.failureEvent.generationFailedSequence,
    "cell.phases.confirmedDetailFatal.failureEvent.generationFailedSequence",
  );
  if (
    confirmedRuntimeFailedSequence >= confirmedTerminalSequence ||
    confirmedTerminalSequence >= confirmedGenerationFailedSequence
  ) {
    fail(
      "cell.phases.confirmedDetailFatal.failureEvent",
      "runtimeFailed, verified-fatal terminal, and generationFailed are out of order",
    );
  }
  const confirmedTerminal = record(
    confirmedFatal.failureEvent.pageAttemptTerminal,
    "cell.phases.confirmedDetailFatal.failureEvent.pageAttemptTerminal",
  );
  exactString(
    confirmedTerminal.terminal,
    "verified-fatal",
    "cell.phases.confirmedDetailFatal.failureEvent.pageAttemptTerminal.terminal",
  );
  if (
    JSON.stringify(
      identity(
        confirmedTerminal,
        "cell.phases.confirmedDetailFatal.failureEvent.pageAttemptTerminal",
      ),
    ) !== JSON.stringify(confirmedFailure)
  ) {
    fail(
      "cell.phases.confirmedDetailFatal.failureEvent.pageAttemptTerminal",
      "must match the failed detail identity",
    );
  }
  if (
    confirmedFailure.contextId === beforeConfirmedFatal.identity.contextId ||
    !beforeConfirmedFatal.contextIds.includes(confirmedFailure.contextId) ||
    confirmedFailure.generationId !==
      beforeConfirmedFatal.identity.generationId ||
    confirmedFailure.bundleId !== c.bundleId ||
    confirmedFailure.releaseId !== c.releaseId
  ) {
    fail(
      "cell.phases.confirmedDetailFatal.failureEvent",
      "must identify the admitted detail page in confirmed C",
    );
  }
  generationRetirement(
    confirmedFatal.generationRetirement,
    beforeConfirmedFatal,
    "cell.phases.confirmedDetailFatal.generationRetirement",
    false,
  );
  const confirmedFatalRecovered = readyLaunch(
    confirmedFatal.recovered,
    c,
    "cell.phases.confirmedDetailFatal.recovered",
  );
  nativeConfirmation(
    confirmedFatalRecovered.confirmation,
    "ALREADY_CONFIRMED",
    null,
    "cell.phases.confirmedDetailFatal.recovered.confirmation",
  );
  if (
    confirmedFatalRecovered.identity.processId !==
      beforeConfirmedFatal.identity.processId ||
    confirmedFatalRecovered.identity.generationId ===
      beforeConfirmedFatal.identity.generationId ||
    beforeConfirmedFatal.contextIds.some((contextId) =>
      confirmedFatalRecovered.contextIds.includes(contextId),
    )
  ) {
    fail(
      "cell.phases.confirmedDetailFatal.recovered",
      "must replace both failed C page contexts in the same process",
    );
  }
  recovery(
    phases.confirmedInterruptionRecovery,
    "confirmed-interruption",
    confirmedInterruption,
    c,
    "cell.phases.confirmedInterruptionRecovery",
  );
  recovery(
    phases.fatalRecovery,
    "fatal",
    fatal,
    c,
    "cell.phases.fatalRecovery",
  );
  recovery(
    phases.unconfirmedRecovery,
    "unconfirmed",
    unconfirmed,
    c,
    "cell.phases.unconfirmedRecovery",
  );
  const reverse = record(phases.reverseRollback, "cell.phases.reverseRollback");
  const cToB = record(reverse.cToB, "cell.phases.reverseRollback.cToB");
  deltaDelivery(
    cToB.delivery,
    string(c.bundleId, "cell.builds.C.bundleId"),
    b,
    "cell.phases.reverseRollback.cToB.delivery",
  );
  rawDetailRejections(
    cToB.rawDetailRejections,
    b,
    c,
    platform,
    "cell.phases.reverseRollback.cToB.rawDetailRejections",
  );
  const rollbackB = readyLaunch(
    cToB.launch,
    b,
    "cell.phases.reverseRollback.cToB.launch",
  );
  nativeConfirmation(
    rollbackB.confirmation,
    "CONFIRMED",
    {
      kind: "UPDATE_APPLIED",
      from: {
        bundleId: string(c.bundleId, "cell.builds.C.bundleId"),
        releaseId: nullableString(c.releaseId, "cell.builds.C.releaseId"),
      },
      to: {
        bundleId: string(b.bundleId, "cell.builds.B.bundleId"),
        releaseId: nullableString(b.releaseId, "cell.builds.B.releaseId"),
      },
    },
    "cell.phases.reverseRollback.cToB.launch.confirmation",
  );
  const bToA = record(reverse.bToA, "cell.phases.reverseRollback.bToA");
  deltaDelivery(
    bToA.delivery,
    string(b.bundleId, "cell.builds.B.bundleId"),
    serverA,
    "cell.phases.reverseRollback.bToA.delivery",
  );
  rawDetailRejections(
    bToA.rawDetailRejections,
    serverA,
    b,
    platform,
    "cell.phases.reverseRollback.bToA.rawDetailRejections",
  );
  const rollbackA = readyLaunch(
    bToA.launch,
    serverA,
    "cell.phases.reverseRollback.bToA.launch",
  );
  nativeConfirmation(
    rollbackA.confirmation,
    "CONFIRMED",
    {
      kind: "UPDATE_APPLIED",
      from: {
        bundleId: string(b.bundleId, "cell.builds.B.bundleId"),
        releaseId: nullableString(b.releaseId, "cell.builds.B.releaseId"),
      },
      to: {
        bundleId: string(serverA.bundleId, "cell.builds.serverA.bundleId"),
        releaseId: nullableString(
          serverA.releaseId,
          "cell.builds.serverA.releaseId",
        ),
      },
    },
    "cell.phases.reverseRollback.bToA.launch.confirmation",
  );
  if (
    rollbackB.identity.processId !== rollbackA.identity.processId ||
    rollbackB.identity.generationId === rollbackA.identity.generationId ||
    rollbackB.contextIds.some((contextId) =>
      rollbackA.contextIds.includes(contextId),
    )
  ) {
    fail(
      "cell.phases.reverseRollback",
      "reverse rollback must replace both managed pages in one OS process",
    );
  }
  boolean(cell.passed, true, "cell.passed");
}

export function expectedLynxMatrixCellIds(
  platforms: readonly LynxMatrixPlatform[] = LYNX_MATRIX_PLATFORMS,
  frameworks: readonly LynxMatrixFramework[] = LYNX_MATRIX_FRAMEWORKS,
): string[] {
  return platforms.flatMap((platform) =>
    frameworks.map((framework) => `${framework}-${platform}`),
  );
}

export function validateLynxMatrixSummary(
  value: unknown,
  expectedCellIds = expectedLynxMatrixCellIds(),
): void {
  const summary = record(value, "summary");
  exactString(
    summary.schemaVersion,
    "lynx-public-matrix-summary-v2",
    "summary.schemaVersion",
  );
  const cells = summary.cells;
  if (!Array.isArray(cells)) fail("summary.cells", "expected an array");
  cells.forEach(validateLynxMatrixCell);
  const summaryCommit = string(summary.commit, "summary.commit");
  if (!/^[a-f0-9]{40}$/.test(summaryCommit)) {
    fail("summary.commit", "expected a full Git commit");
  }
  const ids = cells.map((cell, index) =>
    string(
      record(cell, `summary.cells[${index}]`).cellId,
      `summary.cells[${index}].cellId`,
    ),
  );
  sameMembers(ids, expectedCellIds, "summary.cells");
  const platforms = [
    ...new Set(
      cells.map((cell, index) =>
        string(
          record(cell, `summary.cells[${index}]`).platform,
          `summary.cells[${index}].platform`,
        ),
      ),
    ),
  ] as LynxMatrixPlatform[];
  validateLynxNativeArtifactsReceipt(summary.nativeArtifacts, {
    appId: "com.hotupdater.lynxmatrix",
    commit: summaryCommit,
    platforms,
    target: "matrix",
  });
  cells.forEach((cell, index) => {
    const item = record(cell, `summary.cells[${index}]`);
    exactString(item.commit, summaryCommit, `summary.cells[${index}].commit`);
    if (
      JSON.stringify(item.nativeArtifacts) !==
      JSON.stringify(summary.nativeArtifacts)
    ) {
      fail(
        `summary.cells[${index}].nativeArtifacts`,
        "must equal the summary native artifact receipt",
      );
    }
  });
  boolean(summary.passed, true, "summary.passed");
}
