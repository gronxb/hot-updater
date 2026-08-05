import { readFileSync, realpathSync } from "fs";
import { readFile } from "fs/promises";
import path from "path";

import { createJiti } from "jiti";
import { parseSync } from "oxc-parser";

import { virtualizeGeneratedSchemaImports } from "./generated-schema-virtual-module";

export type GeneratedSchemaJiti = Readonly<{
  clearVirtualizedProjectModules: () => void;
  importWithoutNativeFallback: <T>(filename: string) => Promise<T>;
}>;

function wrapCommonJsModule(source: string): string {
  const shebangMatch =
    /^#![^\n\r\u2028\u2029]*(?:\r\n|[\n\r\u2028\u2029]|$)/u.exec(source);
  let shebang = "";
  let body = source;
  if (shebangMatch) {
    shebang = shebangMatch[0];
    body = source.slice(shebang.length);
    if (!/[\n\r\u2028\u2029]$/u.test(shebang)) shebang += "\n";
  }
  const wrapperStart =
    "(function (exports, require, module, __filename, __dirname) {";
  const wrapperEnd =
    "}).call(exports, exports, require, module, __filename, __dirname);";
  return `${shebang}${wrapperStart}\n${body}\n${wrapperEnd}`;
}

function isValidCommonJsSource(source: string, extension: string): boolean {
  const parseOptions = {
    astType: "ts",
    lang: extension === ".cts" ? "ts" : "js",
  } as const;
  const unambiguousResult = parseSync("hot-updater-config", source, {
    ...parseOptions,
    sourceType: "unambiguous",
  });
  if (
    unambiguousResult.errors.length === 0 &&
    unambiguousResult.program.sourceType === "module"
  ) {
    return false;
  }

  const commonJsResult = parseSync("hot-updater-config", source, {
    ...parseOptions,
    sourceType: "commonjs",
  });
  return commonJsResult.errors.length === 0;
}

function usesCommonJsWrapper(
  filename: string | undefined,
  source: string,
): boolean {
  if (!filename) return false;
  const canonicalFilename = realpathSync.native(filename);
  const extension = path.extname(canonicalFilename);
  if (extension === ".cjs" || extension === ".cts") {
    return isValidCommonJsSource(source, extension);
  }
  if (extension !== ".js") return false;

  let directory = path.dirname(canonicalFilename);
  while (true) {
    let packageJsonSource: string;
    try {
      packageJsonSource = readFileSync(
        path.join(directory, "package.json"),
        "utf8",
      );
    } catch (error: unknown) {
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        error.code !== "ENOENT"
      ) {
        throw error;
      }
      const parent = path.dirname(directory);
      if (parent === directory) {
        return isValidCommonJsSource(source, extension);
      }
      directory = parent;
      continue;
    }

    const packageJson: unknown = JSON.parse(packageJsonSource);
    const isCommonJsPackage =
      typeof packageJson !== "object" ||
      packageJson === null ||
      Reflect.get(packageJson, "type") !== "module";
    return isCommonJsPackage && isValidCommonJsSource(source, extension);
  }
}

export function createGeneratedSchemaJiti(cwd: string): GeneratedSchemaJiti {
  const transformedProjectFiles = new Set<string>();
  const virtualModules: Record<string, unknown> = {};
  const sourceTransformer = createJiti(import.meta.url, {
    fsCache: false,
    interopDefault: true,
    moduleCache: false,
  });
  const jiti = createJiti(import.meta.url, {
    fsCache: false,
    interopDefault: true,
    moduleCache: true,
    transform: (transformOptions) => {
      const useCommonJsWrapper = usesCommonJsWrapper(
        transformOptions.filename,
        transformOptions.source,
      );
      const virtualizedSource = virtualizeGeneratedSchemaImports(
        transformOptions.source,
        transformOptions.filename,
        cwd,
        sourceTransformer,
        virtualModules,
        transformedProjectFiles,
        useCommonJsWrapper,
      );
      return {
        code: sourceTransformer.transform({
          ...transformOptions,
          source: useCommonJsWrapper
            ? wrapCommonJsModule(virtualizedSource)
            : virtualizedSource,
        }),
      };
    },
    virtualModules,
  });

  return {
    clearVirtualizedProjectModules() {
      if (Object.keys(virtualModules).length === 0) return;
      for (const [cachePath, cachedModule] of Object.entries(jiti.cache)) {
        if (
          transformedProjectFiles.has(cachePath) ||
          transformedProjectFiles.has(cachedModule.filename)
        ) {
          delete jiti.cache[cachePath];
        }
      }
    },
    async importWithoutNativeFallback<T>(filename: string): Promise<T> {
      const source = await readFile(filename, "utf8");
      return (await jiti.evalModule(source, {
        async: true,
        filename,
        forceTranspile: true,
      })) as T;
    },
  };
}
