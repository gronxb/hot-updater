import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { isBuiltin } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  resolvePackageVersion,
  SERVER_DEFINITION_PATH,
  transformEnv,
} from "@hot-updater/cli-tools";
import { HOT_UPDATER_INFRASTRUCTURE_GENERATION } from "@hot-updater/server";
import { toolingTargetOf } from "@hot-updater/server/database";
import { clientAuthOf, clientPluginsOf } from "@hot-updater/server/db";
import { build as buildHelper } from "tsdown";

import {
  CLIENT_CREDENTIAL_SCRIPT,
  renderAgentInstructions,
} from "../src/commands/infra/clientAuth.ts";
import {
  readInfrastructureUpgradeFiles,
  renderInfrastructureUpgradeIndex,
} from "../src/commands/infra/upgradeFiles.ts";
import { INFRASTRUCTURE_UPDATES } from "../src/commands/infrastructureUpdates.ts";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const repoRoot = path.resolve(packageRoot, "../..");
const outputRoot = path.join(packageRoot, "dist/infra-templates");
const providers = ["cloudflare", "supabase", "aws", "firebase"];
const builds = ["bare", "rock", "expo"];
const upgradeFiles = await readInfrastructureUpgradeFiles(
  path.join(packageRoot, "infrastructure-upgrades"),
  INFRASTRUCTURE_UPDATES,
);
const json = async (file) => JSON.parse(await readFile(file, "utf8"));
const save = async (file, value) => {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(
    file,
    typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`,
  );
};
const pluginRoot = (provider) => path.join(repoRoot, "plugins", provider);
const moduleAt = (file) => import(pathToFileURL(file).href);
const placeholder = (name) => `__HOT_UPDATER_${name}__`;
const versions = {};
for (const directory of [
  "packages/hot-updater",
  "packages/server",
  "packages/react-native",
  ...[...providers, ...builds].map((name) => `plugins/${name}`),
]) {
  const pkg = await json(path.join(repoRoot, directory, "package.json"));
  versions[pkg.name] = pkg.version;
}

// The same built runtimes are deployed by interactive init. Capture their
// external dependencies so the extracted projects work outside this monorepo.
const runtimeDependencies = async (directory, provider) => {
  const dependencies = {};
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      Object.assign(
        dependencies,
        await runtimeDependencies(path.join(directory, entry.name), provider),
      );
    } else if (/\.(cjs|mjs|js)$/.test(entry.name)) {
      const text = await readFile(path.join(directory, entry.name), "utf8");
      for (const [, specifier] of text.matchAll(
        /\brequire\(["']([^"']+)["']\)/g,
      )) {
        if (specifier.startsWith(".") || isBuiltin(specifier)) continue;
        const name = specifier.startsWith("@")
          ? specifier.split("/").slice(0, 2).join("/")
          : specifier.split("/")[0];
        dependencies[name] = resolvePackageVersion(name, {
          searchFrom: pluginRoot(provider),
        });
      }
    }
  }
  return dependencies;
};

await buildHelper({
  config: false,
  entry: { "verify-server": path.join(packageRoot, "agent/verify-server.mjs") },
  outDir: path.join(packageRoot, "dist/agent"),
  format: ["esm"],
  dts: false,
  exports: false,
  deps: { onlyBundle: false },
});
await rm(outputRoot, { recursive: true, force: true });
for (const provider of providers) {
  const root = pluginRoot(provider);
  const output = path.join(outputRoot, provider);
  await mkdir(output, { recursive: true });
  // The plugins the provider's prebuilt server runs set its client-route
  // policy, which the scaffold provisions, documents, and checks, and name
  // the client plugins an app adds.
  const { plugins } = await moduleAt(path.join(root, "src/plugins.ts"));
  const clientAuth = clientAuthOf(plugins) ?? null;
  const clientPlugins = clientPluginsOf(plugins);
  await cp(path.join(root, "agent"), output, { recursive: true });
  for (const [source, file] of [
    ...(await readdir(output))
      .filter((name) => name.endsWith(".md"))
      .map((name) => [path.join(output, name), name]),
    [path.join(packageRoot, "agent/COMMON.md"), "COMMON.md"],
  ]) {
    await save(
      path.join(output, file),
      renderAgentInstructions(await readFile(source, "utf8"), {
        clientAuth,
        clientPlugins,
      }),
    );
  }
  const templateModule = await moduleAt(
    path.join(
      root,
      "iac",
      provider === "aws" ? "templates.ts" : "configTemplate.ts",
    ),
  );
  const scaffoldOf = (build) =>
    provider === "aws"
      ? templateModule.getConfigScaffold(build, {
          mode: "local",
          profile: null,
        })
      : templateModule.getConfigScaffold(build);
  for (const build of builds) {
    await save(
      path.join(output, "app", `hot-updater.config.${build}.ts`),
      `${scaffoldOf(build).text}\n`,
    );
  }
  // Every build's config points at the server definition init writes, which
  // holds no build: the database, storage, and plugins the provider's
  // prebuilt server runs.
  const { definition } = scaffoldOf(builds[0]);
  await save(
    path.join(output, "app", SERVER_DEFINITION_PATH),
    `${definition.text}\n`,
  );
  if (provider === "firebase") {
    // Firestore has no migration tooling, so the credential script runs the
    // migrator of the server definition it loaded: core's settings and those
    // of the definition's plugins, over the definition's own database.
    await save(
      path.join(output, "app/migrate.ts"),
      `import { createMigrator } from "@hot-updater/server/db";

/**
 * Writes the schema settings of core and the plugins \`hotUpdater\` runs,
 * which its database checks before its first read.
 */
export const migrate = async (
  hotUpdater: Parameters<typeof createMigrator>[0],
) => {
  const result = await createMigrator(hotUpdater).migrateToLatest({
    mode: "from-schema",
    updateSettings: true,
  });
  await result.execute();
};
`,
    );
  }
  await cp(
    path.join(packageRoot, "agent", CLIENT_CREDENTIAL_SCRIPT),
    path.join(output, "app", CLIENT_CREDENTIAL_SCRIPT),
  );

  await cp(
    path.join(packageRoot, "dist/agent/verify-server.mjs"),
    path.join(output, "app/verify-server.mjs"),
  );

  const providerVersion = versions[`@hot-updater/${provider}`];
  const requirements = {};
  if (provider === "cloudflare") {
    await cp(path.join(root, "worker/dist"), path.join(output, "worker/dist"), {
      recursive: true,
    });
    await cp(
      path.join(root, "worker/migrations"),
      path.join(output, "worker/migrations"),
      { recursive: true },
    );
    // The package's migration holds core's tables; the prebuilt Worker's
    // plugins need theirs after it, as init migrates them.
    const { d1SchemaSql } = await moduleAt(path.join(root, "src/d1Schema.ts"));
    await save(
      path.join(output, "worker/migrations/0002_hot-updater_plugins.sql"),
      d1SchemaSql(toolingTargetOf(plugins)),
    );
    const config = await json(path.join(root, "worker/wrangler.json"));
    config.name = placeholder("WORKER_NAME");
    config.account_id = placeholder("ACCOUNT_ID");
    config.d1_databases[0].database_id = placeholder("D1_DATABASE_ID");
    config.d1_databases[0].database_name = placeholder("D1_DATABASE_NAME");
    config.r2_buckets[0].bucket_name = placeholder("BUCKET_NAME");
    config.vars.BUCKET_NAME = placeholder("BUCKET_NAME");
    await save(path.join(output, "worker/wrangler.json"), config);
    await save(path.join(output, "worker/package.json"), {
      name: "hot-updater-worker",
      private: true,
      type: "module",
      scripts: {
        deploy: "wrangler deploy",
        migrations: "wrangler d1 migrations apply --remote",
      },
      devDependencies: {
        wrangler: resolvePackageVersion("wrangler", { searchFrom: root }),
      },
    });
    Object.assign(requirements, {
      workerName: null,
      accountId: null,
      d1DatabaseId: null,
      d1DatabaseName: null,
      bucketName: null,
    });
  } else if (provider === "supabase") {
    const functions = path.join(output, "supabase/functions/hot-updater-v1");
    await save(
      path.join(functions, "index.ts"),
      transformEnv(path.join(root, "supabase/edge-functions/index.ts"), {
        BUCKET_NAME: placeholder("BUCKET_NAME"),
        FUNCTION_NAME: "hot-updater-v1",
      }),
    );
    const { resolveEdgeFunctionDenoConfig, supabaseSchemaSql } = await moduleAt(
      path.join(root, "dist/iac/index.mjs"),
    );
    await save(
      path.join(functions, "deno.json"),
      await resolveEdgeFunctionDenoConfig(functions),
    );
    await cp(
      path.join(root, "supabase/migrations"),
      path.join(output, "supabase/migrations"),
      { recursive: true },
    );
    // The package's migration holds core's tables; the prebuilt function's
    // plugins need theirs after it, as init migrates them.
    await save(
      path.join(
        output,
        "supabase/migrations/20260818000001_hot-updater_plugins.sql",
      ),
      supabaseSchemaSql(toolingTargetOf(plugins)),
    );
    await save(
      path.join(output, "supabase/config.toml"),
      `project_id = "${placeholder("PROJECT_ID")}"\n\n[db.seed]\nenabled = false\n\n[functions.hot-updater-v1]\nverify_jwt = false\n`,
    );
    Object.assign(requirements, {
      projectId: null,
      bucketName: null,
      functionName: "hot-updater-v1",
    });
  } else if (provider === "aws") {
    const lambda = path.join(output, "lambda");
    await cp(path.join(root, "dist/lambda"), lambda, { recursive: true });
    const inputs = [
      "CLOUDFRONT_KEY_PAIR_ID",
      "DYNAMODB_REGION",
      "DYNAMODB_TABLE_NAME",
      "SSM_PARAMETER_NAME",
      "SSM_REGION",
      "S3_BUCKET_NAME",
    ];
    await save(
      path.join(lambda, "index.cjs"),
      transformEnv(
        path.join(lambda, "index.cjs"),
        Object.fromEntries(inputs.map((name) => [name, placeholder(name)])),
      ),
    );
    await save(path.join(lambda, "package.json"), {
      name: "hot-updater-edge",
      private: true,
      main: "index.cjs",
      engines: { node: "22" },
      dependencies: await runtimeDependencies(lambda, provider),
    });
    const cloudfront = await moduleAt(
      path.join(root, "iac/cloudfrontDistributionConfig.ts"),
    );
    const distribution = cloudfront.buildDistributionConfig({
      bucketName: placeholder("S3_BUCKET_NAME"),
      bucketDomain: placeholder("S3_REGIONAL_DOMAIN"),
      functionArn: placeholder("QUALIFIED_LAMBDA_ARN"),
      keyGroupId: placeholder("KEY_GROUP_ID"),
      oacId: placeholder("OAC_ID"),
      originRequestPolicyId: placeholder("ORIGIN_REQUEST_POLICY_ID"),
      releaseCatalogCachePolicyId: placeholder("CATALOG_CACHE_POLICY_ID"),
      sharedCachePolicyId: placeholder("CACHE_POLICY_ID"),
    });
    distribution.CallerReference = placeholder("CALLER_REFERENCE");
    await save(path.join(output, "cloudfront/distribution.json"), distribution);
    // Caches key on the headers the server's client-route policy reads.
    const clientHeaders = clientAuth?.varyHeaders ?? [];
    await save(path.join(output, "cloudfront/cache-policy.json"), {
      CachePolicyConfig: cloudfront.buildSharedCachePolicyConfig(clientHeaders),
    });
    await save(path.join(output, "cloudfront/catalog-cache-policy.json"), {
      CachePolicyConfig:
        cloudfront.buildReleaseCatalogCachePolicyConfig(clientHeaders),
    });
    await save(path.join(output, "cloudfront/origin-request-policy.json"), {
      OriginRequestPolicyConfig:
        cloudfront.buildOriginRequestPolicyConfig(clientHeaders),
    });
    const awsInputs = await moduleAt(path.join(root, "dist/iac/index.mjs"));
    await save(
      path.join(output, "dynamodb/create-table.json"),
      awsInputs.buildDynamoDBCreateTableInput(
        placeholder("DYNAMODB_TABLE_NAME"),
      ),
    );
    await save(
      path.join(output, "dynamodb/enable-pitr.json"),
      awsInputs.buildDynamoDBBackupInput(placeholder("DYNAMODB_TABLE_NAME")),
    );
    await save(
      path.join(output, "dynamodb/enable-ttl.json"),
      awsInputs.buildDynamoDBTimeToLiveInput(
        placeholder("DYNAMODB_TABLE_NAME"),
      ),
    );
    await save(
      path.join(output, "dynamodb/schema-settings.json"),
      awsInputs.buildDynamoDBSchemaSettingsInput(
        placeholder("DYNAMODB_TABLE_NAME"),
      ),
    );
    await save(
      path.join(output, "iam/trust-policy.json"),
      awsInputs.LAMBDA_EDGE_TRUST_POLICY,
    );
    await save(
      path.join(output, "iam/dynamodb-policy.json"),
      awsInputs.buildDynamoDBPolicy(
        placeholder("DYNAMODB_REGION"),
        placeholder("ACCOUNT_ID"),
        placeholder("DYNAMODB_TABLE_NAME"),
      ),
    );
    await save(
      path.join(output, "iam/s3-policy.json"),
      awsInputs.buildS3Policy(placeholder("S3_BUCKET_NAME")),
    );
    await save(
      path.join(output, "iam/ssm-policy.json"),
      awsInputs.buildSsmPolicy(
        placeholder("SSM_REGION"),
        placeholder("ACCOUNT_ID"),
        placeholder("SSM_PARAMETER_PATH"),
      ),
    );
    // Keep the authoritative table, IAM and signing specifications available
    // alongside the deployment payload; these are reference code, not runners.
    for (const file of ["dynamodb.ts", "iam.ts", "ssm.ts"]) {
      await save(
        path.join(output, "reference", file),
        await readFile(path.join(root, "iac", file), "utf8"),
      );
    }
    Object.assign(requirements, {
      accountId: null,
      region: null,
      bucketName: null,
      tableName: null,
      lambdaName: null,
      roleName: null,
      roleArn: null,
      qualifiedLambdaArn: null,
      oacId: null,
      cachePolicyId: null,
      catalogCachePolicyId: null,
      originRequestPolicyId: null,
      distributionId: null,
      distributionCallerReference: null,
      publicKeyId: null,
      keyGroupId: null,
      ssmParameterName: null,
    });
  } else {
    const firebase = path.join(output, "firebase");
    const { prepareFirebaseTemplate } = await moduleAt(
      path.join(root, "iac/prepareTemplate.ts"),
    );
    const prepared = await prepareFirebaseTemplate(
      path.join(root, "dist/firebase"),
    );
    try {
      await cp(prepared.tmpDir, firebase, { recursive: true });
    } finally {
      await prepared.removeTmpDir();
    }
    const functions = path.join(firebase, "functions");
    await save(
      path.join(functions, "index.cjs"),
      transformEnv(path.join(functions, "index.cjs"), {
        REGION: placeholder("REGION"),
      }),
    );
    const pkg = await json(path.join(functions, "package.json"));
    pkg.dependencies = await runtimeDependencies(functions, provider);
    await save(path.join(functions, "package.json"), pkg);
    await save(path.join(firebase, ".firebaserc"), {
      projects: { default: placeholder("PROJECT_ID") },
    });
    Object.assign(requirements, {
      projectId: null,
      region: null,
      storageBucket: null,
    });
  }

  for (const upgrade of upgradeFiles)
    await save(path.join(output, "upgrades", upgrade.file), upgrade.content);
  await save(
    path.join(output, "upgrades/README.md"),
    renderInfrastructureUpgradeIndex(upgradeFiles),
  );
  const appPackages = {
    ...versions,
  };
  if (provider === "aws")
    appPackages["@aws-sdk/credential-providers"] = resolvePackageVersion(
      "@aws-sdk/credential-providers",
      { searchFrom: root },
    );
  if (provider === "firebase")
    appPackages["firebase-admin"] = resolvePackageVersion("firebase-admin", {
      searchFrom: root,
    });
  await save(path.join(output, "template.json"), {
    schemaVersion: 1,
    provider,
    cliVersion: versions["hot-updater"],
    providerVersion,
    serverVersion: versions["@hot-updater/server"],
    infrastructureGeneration: HOT_UPDATER_INFRASTRUCTURE_GENERATION,
    clientAuth,
    clientPlugins,
    packages: Object.fromEntries(
      Object.entries(appPackages).filter(
        ([name]) =>
          name === `@hot-updater/${provider}` ||
          !providers.some((item) => name === `@hot-updater/${item}`),
      ),
    ),
    requiredInputs: requirements,
    upgradeRequirements: INFRASTRUCTURE_UPDATES.map(({ version }) => version),
  });
}
