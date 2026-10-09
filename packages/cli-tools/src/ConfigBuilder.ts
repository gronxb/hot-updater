export type BuildType = "bare" | "rock" | "expo";

export type ImportInfo = {
  pkg: string;
  named?: string[]; // e.g., ['defineConfig']
  defaultOrNamespace?: string; // e.g., '* as admin'
  sideEffect?: boolean;
};

export type ProviderConfig = {
  imports: ImportInfo[]; // Imports required specifically by this provider part
  configString: string; // The JS code string for storage: ..., database: ...
  /**
   * Options an earlier version of this adapter accepted that the current one
   * rejects, such as `cloudflareApiToken` in `r2Storage`: init deletes them
   * from the project's call when it merges into an existing config.
   */
  removedOptions?: readonly string[];
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

export type ConfigBuilderScaffold = {
  imports: ImportInfo[];
  buildConfigString: string;
  storageConfigString: string;
  storageRemovedOptions: readonly string[];
  databaseConfigString: string;
  databaseRemovedOptions: readonly string[];
  pluginsConfigString: string;
  intermediateCode: string;
  text: string;
};

/**
 * Renders the hot-updater.config.ts init writes: the build, the server's
 * storage, database, and plugins, and the deploy settings.
 */
export class ConfigBuilder {
  private buildType: BuildType | null = null;
  private storageInfo: ProviderConfig | null = null;
  private databaseInfo: ProviderConfig | null = null;
  private pluginsInfo: ProviderConfig | null = null;
  private intermediateCode = "";
  private readonly imports: ImportInfo[] = [
    { pkg: "hot-updater", named: ["defineConfig"] },
    { pkg: "node:fs", named: ["existsSync"] },
  ];

  /** Adds an import, such as a credentials helper's. */
  public addImport(info: ImportInfo): this {
    this.imports.push(info);
    return this;
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
        throw new Error(`Invalid build type: ${this.buildType}`);
    }
  }

  /** Sets the build type ('bare', 'rock', or 'expo') and its import. */
  setBuildType(buildType: BuildType): this {
    this.buildType = buildType;
    this.imports.push({
      pkg: `@hot-updater/${buildType}`,
      named: [buildType],
    });
    return this;
  }

  /** Sets the storage the CLI uploads to, which the server lists, and its imports. */
  setStorage(storageConfig: ProviderConfig): this {
    this.storageInfo = storageConfig;
    this.imports.push(...storageConfig.imports);
    return this;
  }

  /** Sets the server's database and its imports. */
  setDatabase(databaseConfig: ProviderConfig): this {
    this.databaseInfo = databaseConfig;
    this.imports.push(...databaseConfig.imports);
    return this;
  }

  /** Sets the server's plugin factory array and its imports. */
  setPlugins(pluginsConfig: ProviderConfig): this {
    this.pluginsInfo = pluginsConfig;
    this.imports.push(...pluginsConfig.imports);
    return this;
  }

  /** Sets the code between the environment loading and the config, such as a credentials helper. */
  setIntermediateCode(code: string): this {
    this.intermediateCode = code.trim();
    return this;
  }

  getScaffold(): ConfigBuilderScaffold {
    if (!this.buildType)
      throw new Error("Build type must be set using .setBuildType()");
    if (!this.storageInfo)
      throw new Error("Storage config must be set using .setStorage()");
    if (!this.databaseInfo)
      throw new Error("Database config must be set using .setDatabase()");
    if (!this.pluginsInfo)
      throw new Error("Plugins config must be set using .setPlugins()");

    const imports = normalizeImportInfos(this.imports);
    const buildConfigString = this.generateBuildConfigString();
    const plugins = this.pluginsInfo.configString;
    const text = `
${renderImportStatements(imports)}

if (existsSync(".env.hotupdater")) {
  process.loadEnvFile(".env.hotupdater");
}

${this.intermediateCode ? `${this.intermediateCode}\n\n` : ""}export default defineConfig({
  build: ${buildConfigString},
  storage: ${this.storageInfo.configString},
  database: ${this.databaseInfo.configString},
  ${plugins === "plugins" ? "plugins" : `plugins: ${plugins}`},
  updateStrategy: "appVersion", // or "fingerprint"
});
`.trim();

    return {
      imports,
      buildConfigString,
      storageConfigString: this.storageInfo.configString,
      storageRemovedOptions: this.storageInfo.removedOptions ?? [],
      databaseConfigString: this.databaseInfo.configString,
      databaseRemovedOptions: this.databaseInfo.removedOptions ?? [],
      pluginsConfigString: plugins,
      intermediateCode: this.intermediateCode,
      text,
    };
  }

  /** hot-updater.config.ts's text. */
  getResult(): string {
    return this.getScaffold().text;
  }
}
