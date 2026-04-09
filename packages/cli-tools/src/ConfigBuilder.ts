// types.ts (or place in the same file initially)

export type BuildType = "bare" | "rock" | "expo";

export type ImportInfo = {
  pkg: string;
  named?: string[]; // e.g., ['defineConfig']
  defaultOrNamespace?: string; // e.g., '* as admin'
  sideEffect?: boolean; // e.g., true for "dotenv/config"
};

export type ProviderConfig = {
  imports: ImportInfo[]; // Imports required specifically by this provider part
  configString: string; // The JS code string for storage: ..., database: ...
};

export type ConfigBuilderScaffold = {
  imports: ImportInfo[];
  buildConfigString: string;
  storageConfigString: string;
  databaseConfigString: string;
  intermediateCode: string;
  text: string;
};

const normalizeImportInfos = (imports: ImportInfo[]) => {
  const collectedImports = new Map<
    string,
    { named: Set<string>; defaultOrNamespace?: string; sideEffect?: boolean }
  >();

  for (const info of imports) {
    const existing = collectedImports.get(info.pkg);

    if (existing) {
      if (info.named) {
        for (const namedImport of info.named) {
          existing.named.add(namedImport);
        }
      }

      if (info.defaultOrNamespace && !existing.defaultOrNamespace) {
        existing.defaultOrNamespace = info.defaultOrNamespace;
      }

      if (info.sideEffect && !existing.sideEffect) {
        existing.sideEffect = true;
      }
      continue;
    }

    collectedImports.set(info.pkg, {
      named: new Set(info.named ?? []),
      defaultOrNamespace: info.defaultOrNamespace,
      sideEffect: info.sideEffect ?? false,
    });
  }

  return Array.from(collectedImports.entries())
    .sort(([a], [b]) => {
      const isABuild = a.startsWith("@hot-updater/");
      const isBBuild = b.startsWith("@hot-updater/");
      if (isABuild !== isBBuild) return isABuild ? -1 : 1;
      if (a === "dotenv/config") return -1;
      if (b === "dotenv/config") return 1;
      const isAdminA = a === "firebase-admin";
      const isAdminB = b === "firebase-admin";
      if (isAdminA !== isAdminB) return isAdminA ? -1 : 1;
      return a.localeCompare(b);
    })
    .map(([pkg, info]) => ({
      pkg,
      named: Array.from(info.named).sort(),
      defaultOrNamespace: info.defaultOrNamespace,
      sideEffect: info.sideEffect ?? false,
    }));
};

export const renderImportStatements = (imports: ImportInfo[]) => {
  const importLines: string[] = [];

  for (const info of normalizeImportInfos(imports)) {
    if (info.sideEffect) {
      importLines.push(`import "${info.pkg}";`);
      continue;
    }

    if (info.defaultOrNamespace) {
      if (info.pkg === "firebase-admin" && (info.named?.length ?? 0) > 0) {
        importLines.push(
          `import ${info.defaultOrNamespace}, { ${info.named!.join(", ")} } from "${info.pkg}";`,
        );
      } else {
        importLines.push(
          `import ${info.defaultOrNamespace} from "${info.pkg}";`,
        );
      }
      continue;
    }

    if ((info.named?.length ?? 0) > 0) {
      importLines.push(
        `import { ${info.named!.join(", ")} } from "${info.pkg}";`,
      );
    }
  }

  return importLines.join("\n");
};

// Builder Interface
export interface IConfigBuilder {
  /** Sets the build type ('bare' or 'rock' or 'expo') and adds necessary build imports. */
  setBuildType(buildType: BuildType): this;

  /** Sets the storage configuration and adds its required imports. */
  setStorage(storageConfig: ProviderConfig): this;

  /** Sets the database configuration and adds its required imports. */
  setDatabase(databaseConfig: ProviderConfig): this;

  /** Sets the intermediate code block to be placed between imports and defineConfig. */
  setIntermediateCode(code: string): this;

  /** Assembles and returns the final configuration string. */
  getResult(): string;
}

export class ConfigBuilder implements IConfigBuilder {
  private buildType: BuildType | null = null;
  private storageInfo: ProviderConfig | null = null;
  private databaseInfo: ProviderConfig | null = null;
  private intermediateCode = "";

  // Internal state to collect and deduplicate imports
  private collectedImports: Map<
    string,
    { named: Set<string>; defaultOrNamespace?: string; sideEffect?: boolean }
  > = new Map();

  constructor() {
    // Add common imports needed by almost all configurations by default
    this.addImport({ pkg: "dotenv", named: ["config"] });
    this.addImport({ pkg: "hot-updater", named: ["defineConfig"] });
  }

  public addImport(info: ImportInfo): this {
    const pkg = info.pkg;
    const existing = this.collectedImports.get(pkg);

    if (existing) {
      // Merge named imports
      if (info.named) {
        for (const n of info.named) {
          existing.named.add(n);
        }
      }
      // Update default/namespace or sideEffect if not already set
      if (info.defaultOrNamespace && !existing.defaultOrNamespace) {
        existing.defaultOrNamespace = info.defaultOrNamespace;
      }
      if (info.sideEffect && !existing.sideEffect) {
        existing.sideEffect = true; // Mark as side-effect if any part needs it
      }
    } else {
      // Add new entry
      this.collectedImports.set(pkg, {
        named: new Set(info.named ?? []),
        defaultOrNamespace: info.defaultOrNamespace,
        sideEffect: info.sideEffect ?? false,
      });
    }
    return this;
  }

  private addImports(imports: ImportInfo[]): void {
    for (const imp of imports) {
      this.addImport(imp);
    }
  }

  private getImportInfos(): ImportInfo[] {
    return normalizeImportInfos(
      Array.from(this.collectedImports.entries()).map(([pkg, info]) => ({
        pkg,
        named: Array.from(info.named),
        defaultOrNamespace: info.defaultOrNamespace,
        sideEffect: info.sideEffect ?? false,
      })),
    );
  }

  private generateBuildConfigString(): string {
    if (!this.buildType)
      throw new Error("Build type must be set using .setBuildType()");
    switch (this.buildType) {
      case "bare":
        return "bare({ enableHermes: true })";
      case "rock":
        return "rock()";
      case "expo":
        return "expo()";
      default:
        // Should be caught by type system, but good practice
        throw new Error(`Invalid build type: ${this.buildType}`);
    }
  }

  // --- Public Builder Methods ---

  setBuildType(buildType: BuildType): this {
    if (this.buildType) {
      // Handle resetting/changing build type if needed, e.g., remove old build import
      // For simplicity now, assume it's set once. Error if called multiple times?
      console.warn(
        "Build type is being set multiple times. Overwriting previous value.",
      );
    }
    this.buildType = buildType;
    this.addImport({ pkg: `@hot-updater/${buildType}`, named: [buildType] });
    return this;
  }

  setStorage(storageConfig: ProviderConfig): this {
    this.storageInfo = storageConfig;
    this.addImports(storageConfig.imports);
    // Auto-add firebase-admin import if firebase is used
    if (storageConfig.imports.some((imp) => imp.pkg.includes("firebase"))) {
      this.addImport({
        pkg: "firebase-admin",
        defaultOrNamespace: "admin",
      });
    }
    return this;
  }

  setDatabase(databaseConfig: ProviderConfig): this {
    this.databaseInfo = databaseConfig;
    this.addImports(databaseConfig.imports);
    // Auto-add firebase-admin import if firebase is used
    if (databaseConfig.imports.some((imp) => imp.pkg.includes("firebase"))) {
      this.addImport({
        pkg: "firebase-admin",
        defaultOrNamespace: "admin",
      });
    }
    return this;
  }

  setIntermediateCode(code: string): this {
    // Trim whitespace but preserve newlines within the code
    this.intermediateCode = code.trim();
    return this;
  }

  getScaffold(): ConfigBuilderScaffold {
    // Validate required parts are set
    if (!this.buildType)
      throw new Error("Build type must be set using .setBuildType()");
    if (!this.storageInfo)
      throw new Error("Storage config must be set using .setStorage()");
    if (!this.databaseInfo)
      throw new Error("Database config must be set using .setDatabase()");

    const imports = this.getImportInfos();
    const importStatements = renderImportStatements(imports);
    const buildConfigString = this.generateBuildConfigString();

    // Assemble the final string
    const text = `
${importStatements}

config({ path: ".env.hotupdater" });

${this.intermediateCode ? `${this.intermediateCode}\n` : ""}
export default defineConfig({
  build: ${buildConfigString},
  storage: ${this.storageInfo.configString},
  database: ${this.databaseInfo.configString},
  updateStrategy: "appVersion", // or "fingerprint"
});
`.trim(); // Ensure trailing newline

    return {
      imports,
      buildConfigString,
      storageConfigString: this.storageInfo.configString,
      databaseConfigString: this.databaseInfo.configString,
      intermediateCode: this.intermediateCode,
      text,
    };
  }

  getResult(): string {
    return this.getScaffold().text;
  }
}
