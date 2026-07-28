import fs from "fs/promises";

import {
  type BuildType,
  ConfigBuilder,
  type ImportInfo,
  type ProviderConfig,
} from "./ConfigBuilder";
import { mergeHotUpdaterConfigText } from "./hotUpdaterConfigMerge";

export type ManagedHelperStrategy =
  | "merge-object"
  | "preserve-existing"
  | "replace";

export type ManagedHelperStatement = {
  name: string;
  code: string;
  strategy: ManagedHelperStrategy;
};

export type CreateHotUpdaterConfigScaffoldOptions = {
  build: BuildType;
  storage: ProviderConfig;
  database: ProviderConfig;
  extraImports?: ImportInfo[];
  helperStatements?: ManagedHelperStatement[];
  updateStrategy?: "appVersion" | "fingerprint";
};

export type CreateHotUpdaterConfigScaffoldFromBuilderOptions = {
  helperStatements?: ManagedHelperStatement[];
  updateStrategy?: "appVersion" | "fingerprint";
};

export type HotUpdaterConfigScaffold = {
  text: string;
  imports: ImportInfo[];
  build: {
    initializer: string;
    callee: string;
  };
  storage: {
    initializer: string;
    callee: string;
  };
  database: {
    initializer: string;
    callee: string;
  };
  helperStatements: ManagedHelperStatement[];
  updateStrategy: string;
};

export type WriteHotUpdaterConfigResult = {
  status: "created" | "merged" | "skipped";
  path: string;
  reason?: string;
};

const HOT_UPDATER_CONFIG_PATH = "hot-updater.config.ts";

const extractCallIdentifier = (initializer: string) => {
  const match = /^\s*([A-Za-z_$][\w$]*)\s*\(/.exec(initializer);
  if (!match) {
    throw new Error(`Failed to extract call identifier from "${initializer}"`);
  }

  return match[1];
};

export const createHotUpdaterConfigScaffold = ({
  build,
  storage,
  database,
  extraImports = [],
  helperStatements = [],
  updateStrategy = "appVersion",
}: CreateHotUpdaterConfigScaffoldOptions): HotUpdaterConfigScaffold => {
  const intermediateCode = helperStatements
    .map((statement) => statement.code.trim())
    .filter(Boolean)
    .join("\n\n");

  const builder = new ConfigBuilder()
    .setBuildType(build)
    .setStorage(storage)
    .setDatabase(database);

  for (const extraImport of extraImports) {
    builder.addImport(extraImport);
  }

  if (intermediateCode) {
    builder.setIntermediateCode(intermediateCode);
  }

  return createHotUpdaterConfigScaffoldFromBuilder(builder, {
    helperStatements,
    updateStrategy,
  });
};

export const createHotUpdaterConfigScaffoldFromBuilder = (
  builder: ConfigBuilder,
  {
    helperStatements = [],
    updateStrategy = "appVersion",
  }: CreateHotUpdaterConfigScaffoldFromBuilderOptions = {},
): HotUpdaterConfigScaffold => {
  const scaffold = builder.getScaffold();
  return {
    text:
      updateStrategy === "appVersion"
        ? scaffold.text
        : scaffold.text.replace(
            'updateStrategy: "appVersion"',
            `updateStrategy: "${updateStrategy}"`,
          ),
    imports: scaffold.imports,
    build: {
      initializer: scaffold.buildConfigString,
      callee: extractCallIdentifier(scaffold.buildConfigString),
    },
    storage: {
      initializer: scaffold.storageConfigString,
      callee: extractCallIdentifier(scaffold.storageConfigString),
    },
    database: {
      initializer: scaffold.databaseConfigString,
      callee: extractCallIdentifier(scaffold.databaseConfigString),
    },
    helperStatements,
    updateStrategy: `"${updateStrategy}"`,
  };
};

export const writeHotUpdaterConfig = async (
  scaffold: HotUpdaterConfigScaffold,
  filePath = HOT_UPDATER_CONFIG_PATH,
): Promise<WriteHotUpdaterConfigResult> => {
  const existingText = await fs.readFile(filePath, "utf-8").catch((error) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }

    throw error;
  });

  if (existingText === null) {
    await fs.writeFile(filePath, `${scaffold.text}\n`, "utf-8");
    return {
      status: "created",
      path: filePath,
    };
  }

  const mergeResult = mergeHotUpdaterConfigText(existingText, scaffold);
  if ("reason" in mergeResult) {
    return {
      status: "skipped",
      path: filePath,
      reason: mergeResult.reason,
    };
  }

  await fs.writeFile(filePath, mergeResult.text, "utf-8");
  return {
    status: "merged",
    path: filePath,
  };
};
