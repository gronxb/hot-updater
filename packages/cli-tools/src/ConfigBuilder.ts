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

/** The server definition file init writes, and the `server` path that points at it. */
export const SERVER_DEFINITION_PATH = "hotUpdater.ts";
export const SERVER_DEFINITION_POINTER = `./${SERVER_DEFINITION_PATH}`;

/** What the server definition file holds, apart from hot-updater.config.ts. */
export type ServerDefinitionScaffold = {
  imports: ImportInfo[];
  storageConfigString: string;
  databaseConfigString: string;
  pluginsConfigString: string;
  intermediateCode: string;
  text: string;
};

export type ConfigBuilderScaffold = {
  /** hot-updater.config.ts's imports. */
  imports: ImportInfo[];
  buildConfigString: string;
  /** The `server` path hot-updater.config.ts points at. */
  server: string;
  /** hot-updater.config.ts. */
  text: string;
  /** The server definition `server` points at. */
  definition: ServerDefinitionScaffold;
};

/** Indents every line after the first, so a multi-line value nests. */
const indentFollowingLines = (text: string, spaces: number) =>
  text.replaceAll("\n", `\n${" ".repeat(spaces)}`);

/**
 * Renders the two files init writes: hot-updater.config.ts, which holds the
 * deploy settings and points at the server definition, and the server
 * definition, which holds the database, storage, and plugins.
 */
export class ConfigBuilder {
  private buildType: BuildType | null = null;
  private storageInfo: ProviderConfig | null = null;
  private databaseInfo: ProviderConfig | null = null;
  private pluginsInfo: ProviderConfig | null = null;
  private intermediateCode = "";
  private readonly configImports: ImportInfo[] = [
    { pkg: "hot-updater", named: ["defineConfig"] },
    { pkg: "node:fs", named: ["existsSync"] },
  ];
  private readonly definitionImports: ImportInfo[] = [
    { pkg: "@hot-updater/server", named: ["createHotUpdater"] },
  ];

  /** Adds an import to the server definition, such as a credentials helper's. */
  public addImport(info: ImportInfo): this {
    this.definitionImports.push(info);
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
    this.configImports.push({
      pkg: `@hot-updater/${buildType}`,
      named: [buildType],
    });
    return this;
  }

  /** Sets the server's storage and its imports. */
  setStorage(storageConfig: ProviderConfig): this {
    this.storageInfo = storageConfig;
    this.definitionImports.push(...storageConfig.imports);
    return this;
  }

  /** Sets the server's database and its imports. */
  setDatabase(databaseConfig: ProviderConfig): this {
    this.databaseInfo = databaseConfig;
    this.definitionImports.push(...databaseConfig.imports);
    return this;
  }

  /** Sets the server's plugins, such as a provider package's `plugins`. */
  setPlugins(pluginsConfig: ProviderConfig): this {
    this.pluginsInfo = pluginsConfig;
    this.definitionImports.push(...pluginsConfig.imports);
    return this;
  }

  /** Sets the code between the server definition's imports and the server. */
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

    const imports = normalizeImportInfos(this.configImports);
    const buildConfigString = this.generateBuildConfigString();
    const text = `
${renderImportStatements(imports)}

if (existsSync(".env.hotupdater")) {
  process.loadEnvFile(".env.hotupdater");
}

export default defineConfig({
  build: ${buildConfigString},
  server: ${JSON.stringify(SERVER_DEFINITION_POINTER)},
  updateStrategy: "appVersion", // or "fingerprint"
});
`.trim();

    const definitionImports = normalizeImportInfos(this.definitionImports);
    const definitionText = `
${renderImportStatements(definitionImports)}

${this.intermediateCode ? `${this.intermediateCode}\n\n` : ""}/**
 * The Hot Updater server: its database, storage, and plugins.
 * hot-updater.config.ts points the CLI and the console here.
 */
export const hotUpdater = createHotUpdater({
  database: ${this.databaseInfo.configString},
  storage: [
    ${indentFollowingLines(this.storageInfo.configString, 2)},
  ],
  ${this.pluginsInfo.configString === "plugins" ? "plugins" : `plugins: ${this.pluginsInfo.configString}`},
});
`.trim();

    return {
      imports,
      buildConfigString,
      server: SERVER_DEFINITION_POINTER,
      text,
      definition: {
        imports: definitionImports,
        storageConfigString: this.storageInfo.configString,
        databaseConfigString: this.databaseInfo.configString,
        pluginsConfigString: this.pluginsInfo.configString,
        intermediateCode: this.intermediateCode,
        text: definitionText,
      },
    };
  }

  /** hot-updater.config.ts's text. */
  getResult(): string {
    return this.getScaffold().text;
  }
}
