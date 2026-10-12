import { isUtf8 } from "node:buffer";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

import {
  compareStringsByCodeUnit,
  type NativeFingerprint,
  type NativeFingerprintOptions,
} from "@hot-updater/plugin-core";
import {
  hashFingerprintSourcePath,
  resolveFingerprintSourcePaths,
} from "@hot-updater/plugin-core/fingerprint";
import { XMLParser } from "fast-xml-parser";

const GENERATED_PATHS = [
  "**/{.build,.cxx,.git,.gradle,.hot-updater,build,DerivedData,node_modules,Pods}/**",
];

const ROOT_NATIVE_INPUTS = [
  "package.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
];

const PLATFORM_NATIVE_INPUTS = {
  android: [
    "android/**/src/main/**/*",
    "android/**/build.gradle",
    "android/**/build.gradle.kts",
    "android/**/*.pro",
    "android/gradle.properties",
    "android/gradle/libs.versions.toml",
    "android/gradle/wrapper/gradle-wrapper.properties",
    "android/settings.gradle",
    "android/settings.gradle.kts",
  ],
  ios: [
    "ios/**/*.c",
    "ios/**/*.cc",
    "ios/**/*.cpp",
    "ios/**/*.entitlements",
    "ios/**/*.h",
    "ios/**/*.m",
    "ios/**/*.mm",
    "ios/**/*.modulemap",
    "ios/**/*.pdf",
    "ios/**/*.plist",
    "ios/**/*.png",
    "ios/**/*.strings",
    "ios/**/*.stringsdict",
    "ios/**/*.storyboard",
    "ios/**/*.swift",
    "ios/**/*.xcassets/**/*",
    "ios/**/*.xcconfig",
    "ios/**/*.xcprivacy",
    "ios/**/*.xcodeproj/project.pbxproj",
    "ios/**/*.xcscheme",
    "ios/**/*.xcworkspace/contents.xcworkspacedata",
    "ios/**/*.xib",
    "ios/Package.resolved",
    "ios/Package.swift",
    "ios/Podfile",
    "ios/Podfile.lock",
  ],
} as const;

const PACKAGE_NATIVE_INPUTS = {
  android: [
    "android/build.gradle",
    "android/fresco-compat.gradle",
    "android/libs/*.jar",
    "android/src/main/**/*",
    "package.json",
  ],
  ios: [
    "ios/*.podspec",
    "ios/Package.swift",
    "ios/Sources/HotUpdaterLynxArtifact/**/*",
    "ios/Sources/HotUpdaterLynxBsdiff/**/*",
    "package.json",
  ],
} as const;

const SPARKLING_NATIVE_INPUTS = {
  android: ["android/build.gradle", "android/src/main/**/*", "package.json"],
  ios: [
    "ios/*.podspec",
    "ios/Package.swift",
    "ios/Sources/HotUpdaterLynxSparkling/**/*",
    "ios/Sources/HotUpdaterLynxSparklingCore/**/*",
    "package.json",
  ],
} as const;

const resolvePackageSources = async (
  cwd: string,
  platform: "ios" | "android",
) => {
  const require = createRequire(path.join(cwd, "package.json"));
  const packages = [
    {
      name: "@hot-updater/lynx",
      patterns: PACKAGE_NATIVE_INPUTS,
      optional: false,
    },
    {
      name: "@hot-updater/lynx-sparkling",
      patterns: SPARKLING_NATIVE_INPUTS,
      optional: true,
    },
  ];
  const sources = await Promise.all(
    packages.map(async ({ name, patterns, optional }) => {
      let packageRoot: string;
      try {
        packageRoot = path.dirname(require.resolve(`${name}/package.json`));
      } catch (error) {
        if (
          optional &&
          (error as NodeJS.ErrnoException).code === "MODULE_NOT_FOUND"
        )
          return [];
        throw error;
      }
      return (
        await resolveFingerprintSourcePaths({
          cwd: packageRoot,
          ignore: GENERATED_PATHS,
          patterns: patterns[platform],
        })
      ).map((source) => ({
        ...source,
        filePath: `${name}/${source.filePath}`,
      }));
    }),
  );
  return sources.flat();
};

interface XmlNode {
  [key: string]: XmlNode[] | string | Record<string, string>;
}

const STRUCTURAL_PLIST_ELEMENTS = new Set(["plist", "dict", "array"]);

const normalizeXmlNodes = (
  nodes: XmlNode[],
  parents: string[] = [],
): XmlNode[] => {
  const result: XmlNode[] = [];
  const parent = parents.join("/");
  for (let index = 0; index < nodes.length; index++) {
    const node = nodes[index];
    const tag = Object.keys(node).find((key) => key !== ":@")!;
    if (tag === "#text") {
      if (
        (parents[0] === "manifest" ||
          STRUCTURAL_PLIST_ELEMENTS.has(parents.at(-1) ?? "")) &&
        !(node[tag] as string).trim()
      )
        continue;
      if (parents[0] === "plist" && parents.at(-1) === "data") {
        const data = (node[tag] as string).replace(/[ \t\r\n]/g, "");
        if (data) result.push({ "#text": data });
      } else {
        result.push(node);
      }
      continue;
    }
    const children = node[tag] as XmlNode[];
    if (
      parent === "plist/dict" &&
      tag === "key" &&
      ["HOT_UPDATER_FINGERPRINT_HASH", "HOT_UPDATER_PUBLIC_KEY"].includes(
        children.map((child) => child["#text"] ?? "").join(""),
      )
    ) {
      let next = index + 1;
      while (
        nodes[next]?.["#text"] !== undefined &&
        !(nodes[next]["#text"] as string).trim()
      )
        next++;
      if (nodes[next]?.string) {
        index = next;
        continue;
      }
    }
    if (
      parent === "manifest/application" &&
      tag === "meta-data" &&
      ["com.hotupdater.FINGERPRINT_HASH", "com.hotupdater.PUBLIC_KEY"].includes(
        (node[":@"] as Record<string, string>)?.["@_android:name"],
      )
    )
      continue;
    result.push({
      ...node,
      [tag]: normalizeXmlNodes(children, [...parents, tag]),
    });
  }
  return result;
};

const normalizeInjectedFingerprint = (filePath: string, bytes: Buffer) => {
  const isManifest =
    filePath.startsWith("android/") && filePath.endsWith("AndroidManifest.xml");
  const isPlist = filePath.startsWith("ios/") && filePath.endsWith(".plist");
  // Preserve unsupported encodings as bytes instead of losing native values
  // during UTF-8 decoding. Initial injection normalization is for UTF-8 XML.
  if (
    (!isManifest && !isPlist) ||
    bytes.subarray(0, 6).toString() === "bplist" ||
    !isUtf8(bytes) ||
    bytes.includes(0)
  )
    return bytes;
  const source = bytes.toString("utf8");
  const encoding = source.match(
    /^\s*<\?xml\s[^?]*\bencoding\s*=\s*(['"])([^'"]+)\1/i,
  )?.[2];
  if (encoding && !/^utf-?8$/i.test(encoding)) return bytes;
  const document = new XMLParser({
    preserveOrder: true,
    ignoreAttributes: false,
    ignoreDeclaration: true,
    parseTagValue: false,
    parseAttributeValue: false,
    trimValues: false,
  }).parse(source) as XmlNode[];
  return Buffer.from(JSON.stringify(normalizeXmlNodes(document)));
};

const hashLynxFingerprintSource = async (
  source: Awaited<ReturnType<typeof resolveFingerprintSourcePaths>>[number],
) => {
  const initial = await hashFingerprintSourcePath(source);
  if (
    source.type !== "file" ||
    source.symbolicLinkTarget !== undefined ||
    (!source.filePath.endsWith("AndroidManifest.xml") &&
      !source.filePath.endsWith(".plist"))
  ) {
    return initial;
  }
  const bytes = await fs.readFile(source.absolutePath);
  const final = await hashFingerprintSourcePath(source);
  if (initial.hash !== final.hash || initial.byteSize !== final.byteSize) {
    throw new Error(`Fingerprint source changed: ${source.filePath}`);
  }
  const normalized = normalizeInjectedFingerprint(source.filePath, bytes);
  return {
    byteSize: normalized.byteLength,
    hash: createHash("sha256").update(normalized).digest("hex"),
  };
};

const resolveExtraPatterns = (
  extraSources: NativeFingerprintOptions["extraSources"],
  platform: "ios" | "android",
) =>
  Array.isArray(extraSources) ? extraSources : (extraSources?.[platform] ?? []);

export async function createLynxNativeFingerprint(
  cwd: string,
  options: NativeFingerprintOptions,
): Promise<NativeFingerprint> {
  const [nativePaths, packagePaths, extraPaths] = await Promise.all([
    resolveFingerprintSourcePaths({
      cwd,
      ignore: [...GENERATED_PATHS, ...(options.ignorePaths ?? [])],
      patterns: [
        ...PLATFORM_NATIVE_INPUTS[options.platform],
        ...ROOT_NATIVE_INPUTS,
      ],
    }),
    resolvePackageSources(cwd, options.platform),
    resolveFingerprintSourcePaths({
      cwd,
      followSymbolicLinks: true,
      includeDirectories: true,
      patterns: resolveExtraPatterns(options.extraSources, options.platform),
    }),
  ]);
  const paths = new Map(
    [...nativePaths, ...packagePaths, ...extraPaths].map((source) => [
      `${source.type}:${source.filePath}`,
      source,
    ]),
  );
  if (paths.size === 0) {
    throw new Error(
      `Lynx fingerprint found no meaningful ${options.platform} native inputs.`,
    );
  }

  const sources = await Promise.all(
    [...paths.values()]
      .sort((left, right) =>
        compareStringsByCodeUnit(left.filePath, right.filePath),
      )
      .map(async (source) => {
        const { byteSize, hash } = await hashLynxFingerprintSource(source);
        return {
          type: source.type,
          filePath: source.filePath,
          reasons: ["lynx-native-input"],
          hash,
          ...(options.debug ? { debugInfo: { byteSize } } : {}),
        };
      }),
  );
  const digest = createHash("sha256");
  for (const source of sources) {
    digest.update(source.type);
    digest.update("\0");
    digest.update(source.filePath);
    digest.update("\0");
    digest.update(source.hash);
    digest.update("\0");
  }
  return { hash: digest.digest("hex"), sources };
}
