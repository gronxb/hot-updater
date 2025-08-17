// types.ts (or place in the same file initially)

export type BuildType = "bare" | "rnef" | "expo";

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

// Builder Interface
export interface IConfigBuilder {
  /** Sets the build type ('bare' or 'rnef' or 'expo') and adds necessary build imports. */
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

  private generateImportStatements(): string {
    const importLines: string[] = [];
    // Sort packages for consistent order (customize as needed)
    const sortedPackages = Array.from(this.collectedImports.keys()).sort(
      (a, b) => {
        // Simple sort: build types, then dotenv, then others alphabetically
        const isABuild = a.startsWith("@hot-updater/");
        const isBBuild = b.startsWith("@hot-updater/");
        if (isABuild !== isBBuild) return isABuild ? -1 : 1;
        if (a === "dotenv/config") return -1;
        if (b === "dotenv/config") return 1;
        const isAdminA = a === "firebase-admin";
        const isAdminB = b === "firebase-admin";
        if (isAdminA !== isAdminB) return isAdminA ? -1 : 1; // Put admin early if present
        return a.localeCompare(b);
      },
    );

    for (const pkg of sortedPackages) {
      const info = this.collectedImports.get(pkg)!;
      if (info.sideEffect) {
        importLines.push(`import "${pkg}";`);
      } else if (info.defaultOrNamespace) {
        // If both namespace and named imports exist for firebase-admin, handle it specially
        if (pkg === "firebase-admin" && info.named.size > 0) {
          importLines.push(
            `import ${info.defaultOrNamespace}, { ${Array.from(info.named).sort().join(", ")} } from "${pkg}";`,
          );
        } else {
          importLines.push(`import ${info.defaultOrNamespace} from "${pkg}";`);
        }
      } else if (info.named.size > 0) {
        const namedPart = Array.from(info.named).sort().join(", ");
        importLines.push(`import { ${namedPart} } from "${pkg}";`);
      }
    }
    return importLines.join("\n");
  }

  private generateBuildConfigString(): string {
    if (!this.buildType)
      throw new Error("Build type must be set using .setBuildType()");
    switch (this.buildType) {
      case "bare":
        return "bare({ enableHermes: true })";
      case "rnef":
        return "rnef()";
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
        defaultOrNamespace: "* as admin",
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
        defaultOrNamespace: "* as admin",
      });
    }
    return this;
  }

  setIntermediateCode(code: string): this {
    // Trim whitespace but preserve newlines within the code
    this.intermediateCode = code.trim();
    return this;
  }

  getResult(): string {
    // Validate required parts are set
    if (!this.buildType)
      throw new Error("Build type must be set using .setBuildType()");
    if (!this.storageInfo)
      throw new Error("Storage config must be set using .setStorage()");
    if (!this.databaseInfo)
      throw new Error("Database config must be set using .setDatabase()");

    const importStatements = this.generateImportStatements();
    const buildConfigString = this.generateBuildConfigString();

    // Assemble the final string
    return `
${importStatements}

config({ path: ".env.hotupdater" });

${this.intermediateCode ? `${this.intermediateCode}\n` : ""}
export default defineConfig({
  build: ${buildConfigString},
  storage: ${this.storageInfo.configString},
  database: ${this.databaseInfo.configString},
  updateStrategy: "fingerprint",
});
`.trim(); // Ensure trailing newline
  }
}
