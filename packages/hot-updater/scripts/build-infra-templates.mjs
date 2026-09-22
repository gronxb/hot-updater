import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { isBuiltin } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  renderImportStatements,
  resolvePackageVersion,
  transformEnv,
} from "@hot-updater/cli-tools";
import { HOT_UPDATER_INFRASTRUCTURE_GENERATION } from "@hot-updater/server";
import { build as buildHelper } from "tsdown";

import {
  readInfrastructureUpgradeFiles,
  renderInfrastructureUpgradeIndex,
} from "../src/commands/infra/upgradeFiles.ts";
import { INFRASTRUCTURE_UPDATES } from "../src/commands/infrastructureUpdates.ts";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const repoRoot = path.resolve(packageRoot, "../..");
const outputRoot = path.join(packageRoot, "dist/infra-templates");
const providers = ["cloudflare", "supabase", "aws", "firebase"];
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
const discoverIntegrations = async () => {
  const integrations = [];
  for (const parent of ["packages", "plugins"]) {
    const parentPath = path.join(repoRoot, parent);
    for (const entry of await readdir(parentPath, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const directory = path.join(parentPath, entry.name);
      const manifestPath = path.join(directory, "package.json");
      let manifest;
      try {
        manifest = await json(manifestPath);
      } catch (error) {
        if (error?.code === "ENOENT") continue;
        throw error;
      }
      if (!manifest.exports?.["./integration"]) continue;
      const source = path.join(directory, "src/integration.ts");
      const { initIntegration } = await moduleAt(source);
      integrations.push({
        descriptor: initIntegration,
        directory: path.relative(repoRoot, directory),
        packageName: manifest.name,
      });
    }
  }
  return integrations.sort((left, right) =>
    left.descriptor.id.localeCompare(right.descriptor.id),
  );
};
const integrations = await discoverIntegrations();
const versions = {};
for (const directory of [
  "packages/hot-updater",
  "packages/server",
  ...providers.map((name) => `plugins/${name}`),
  ...integrations.map(({ directory }) => directory),
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
  await cp(path.join(root, "agent"), output, { recursive: true });
  await cp(
    path.join(packageRoot, "agent/COMMON.md"),
    path.join(output, "COMMON.md"),
  );
  const templateModule = await moduleAt(
    path.join(
      root,
      "iac",
      provider === "aws" ? "templates.ts" : "configTemplate.ts",
    ),
  );
  for (const integration of integrations) {
    const build = integration.descriptor.build;
    const buildId = integration.descriptor.id;
    const config =
      provider === "aws"
        ? templateModule.getConfigScaffold(build, {
            mode: "local",
            profile: null,
          })
        : templateModule.getConfigScaffold(build);
    await save(
      path.join(output, "app", `hot-updater.config.${buildId}.ts`),
      `${config.text}\n`,
    );
    const buildImports = new Set(build.imports.map(({ pkg }) => pkg));
    const imports = config.imports
      .filter(({ pkg }) => pkg !== "hot-updater" && !buildImports.has(pkg))
      .map((info) => ({
        ...info,
        named: info.named?.filter((name) => name !== config.storage.callee),
      }));
    await save(
      path.join(output, "app", `api-key.config.${buildId}.ts`),
      `${renderImportStatements(imports)}\n\nconfig({ path: ".env.hotupdater" });\n\n${config.helperStatements.map(({ code }) => code).join("\n\n")}\n\nexport const database = ${config.database.initializer};\n`,
    );
  }
  await cp(
    path.join(packageRoot, "agent/provision-api-key.mjs"),
    path.join(output, "app/provision-api-key.mjs"),
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
    const { resolveEdgeFunctionDenoConfig } = await moduleAt(
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
    await save(path.join(output, "cloudfront/cache-policy.json"), {
      CachePolicyConfig: cloudfront.HOT_UPDATER_SHARED_CACHE_POLICY_CONFIG,
    });
    await save(path.join(output, "cloudfront/catalog-cache-policy.json"), {
      CachePolicyConfig:
        cloudfront.HOT_UPDATER_RELEASE_CATALOG_CACHE_POLICY_CONFIG,
    });
    await save(path.join(output, "cloudfront/origin-request-policy.json"), {
      OriginRequestPolicyConfig:
        cloudfront.HOT_UPDATER_ORIGIN_REQUEST_POLICY_CONFIG,
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
    const dynamodbSource = await readFile(
      path.join(root, "src/dynamoDB.ts"),
      "utf8",
    );
    await save(
      path.join(output, "reference/dynamodb-constants.json"),
      Object.fromEntries(
        [
          ...dynamodbSource.matchAll(
            /export const (DYNAMODB_\w+)\s*=\s*"([^"]+)"/g,
          ),
        ].map(([, key, value]) => [key, value]),
      ),
    );
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
    dotenv: resolvePackageVersion("dotenv", { searchFrom: packageRoot }),
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
