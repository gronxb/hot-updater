import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";

import { parse as parseToml } from "@iarna/toml";

import {
  getInfraBuildVariants,
  getInfraFiles,
  type InfraManifest,
  readInfraTemplate,
} from "../infra/scaffold";
import { isInitProvider } from "../initProviders";
import { type DoctorCheck, isObject, isText } from "./checks";

// Check deployment inputs only. Instructions, examples and reference source
// deliberately contain placeholders that are not sent to a provider.
const isDeploymentInput = (file: string) =>
  /^(worker|supabase|lambda|cloudfront|dynamodb|iam|firebase)\//.test(file) &&
  !/\.(md|map)$/.test(file);
const hasPlaceholder = (text: string) =>
  /__HOT_UPDATER_[A-Z0-9_]+__|%%BUCKET_NAME%%/.test(text);

export async function readScaffoldFile(root: string, file: string) {
  const resolved = path.resolve(root, file);
  if (!resolved.startsWith(`${path.resolve(root)}${path.sep}`))
    throw new Error("Path outside scaffold");
  const stat = await lstat(resolved);
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new Error("Not a regular file");
  const realRoot = await realpath(root);
  if (!(await realpath(resolved)).startsWith(`${realRoot}${path.sep}`))
    throw new Error("Path resolves outside scaffold");
  return readFile(resolved, "utf8");
}

export async function checkScaffold(infraDir: string): Promise<{
  checks: DoctorCheck[];
  manifest?: InfraManifest;
}> {
  const checks: DoctorCheck[] = [];
  const fail = (
    code: string,
    message: string,
    file: string,
    resolution: string,
  ) =>
    checks.push({
      code,
      status: "fail",
      message,
      paths: [file],
      fixability: "auto",
      resolution,
    });
  let manifest: InfraManifest;
  try {
    const value: unknown = JSON.parse(
      await readScaffoldFile(infraDir, "manifest.json"),
    );
    if (
      !isObject(value) ||
      value["schemaVersion"] !== 1 ||
      !isText(value["provider"]) ||
      !isInitProvider(value["provider"]) ||
      !["scaffold", "setup", "upgrade"].includes(String(value["operation"])) ||
      (value["operation"] !== "scaffold" && !isText(value["build"])) ||
      !isObject(value["files"])
    ) {
      throw new Error("Invalid manifest");
    }
    manifest = value as unknown as InfraManifest;
  } catch {
    fail(
      "INFRA_MANIFEST_INVALID",
      "A supported scaffold manifest is required.",
      "manifest.json",
      "Select the directory returned by infra scaffold or agent infra setup/upgrade.",
    );
    return { checks };
  }

  const { source, template } = await readInfraTemplate(manifest.provider);
  const buildVariants = await getInfraBuildVariants(source);
  if (
    manifest.cliVersion !== template.cliVersion ||
    manifest.providerVersion !== template.providerVersion ||
    manifest.serverVersion !== template.serverVersion ||
    manifest.infrastructureGeneration !== template.infrastructureGeneration
  ) {
    checks.push({
      code: "INFRA_TEMPLATE_VERSION_MISMATCH",
      status: "blocked",
      message: "Scaffold versions do not match this CLI's packaged templates.",
      paths: ["manifest.json"],
      fixability: "command",
      resolution:
        "Run the CLI version that generated this scaffold, or generate a fresh upgrade scaffold. Do not rewrite the manifest to bypass verification.",
    });
    return { checks };
  }

  if (manifest.operation !== "scaffold") {
    const packages = manifest.packages;
    const expectedPackages = Object.entries(template.packages).filter(
      ([name]) =>
        !buildVariants.some(
          (build) =>
            build !== manifest.build && name === `@hot-updater/${build}`,
        ),
    );
    if (
      !isObject(packages) ||
      expectedPackages.some(([name, version]) => packages[name] !== version) ||
      buildVariants.some(
        (build) =>
          build !== manifest.build &&
          packages[`@hot-updater/${build}`] !== undefined,
      )
    ) {
      fail(
        "INFRA_PACKAGE_TARGET_MISMATCH",
        "Manifest package versions or build selection differ from the packaged template.",
        "manifest.json",
        "Compare with a fresh scaffold from the selected CLI; retain its provider/build package targets.",
      );
    }
  }

  if (checks.length === 0) {
    checks.push({
      code: "INFRA_MANIFEST",
      status: "pass",
      message:
        "Provider, build and target versions match the packaged scaffold.",
    });
  }
  // The expected file set comes from the installed CLI, not the editable
  // manifest. Removing a broken file from the manifest cannot suppress a check.
  const expectedFiles = await getInfraFiles(
    source,
    manifest.operation,
    manifest.build,
  );
  const files = new Set([
    ...expectedFiles,
    ...Object.keys(manifest.files),
    ".gitignore",
    ...(manifest.operation !== "scaffold"
      ? ["env.example", "deployment.json"]
      : []),
  ]);
  const contents = new Map<string, string>();
  for (const file of [...files].sort()) {
    let content: string;
    try {
      content = await readScaffoldFile(infraDir, file);
    } catch {
      fail(
        "INFRA_FILE_MISSING_OR_UNSAFE",
        "A scaffold file is missing, unreadable or outside its directory.",
        file,
        "Compare with a fresh scaffold and restore this file inside the selected directory.",
      );
      continue;
    }
    contents.set(file, content);
    if (!isDeploymentInput(file)) continue;
    if (!content.trim() && /\.(js|cjs|mjs|ts|sql|json)$/.test(file)) {
      fail(
        "INFRA_EMPTY_DEPLOYMENT_FILE",
        "A deployment file is empty.",
        file,
        "Restore the supplied runtime, migration or configuration before deploying.",
      );
    }
    if (hasPlaceholder(content)) {
      fail(
        "INFRA_UNRESOLVED_PLACEHOLDER",
        "Deployment input contains an unresolved placeholder.",
        file,
        "Fill deployment placeholders using the selected provider resources, preserving string and SQL escaping.",
      );
    }
    if (file.endsWith(".json") || file.endsWith(".firebaserc")) {
      try {
        JSON.parse(content);
      } catch {
        fail(
          "INFRA_INVALID_JSON",
          "Deployment input is not valid JSON.",
          file,
          "Repair the JSON syntax without changing unrelated provider settings.",
        );
      }
    }
  }
  const json = (file: string): Record<string, unknown> => {
    try {
      const value: unknown = JSON.parse(contents.get(file) ?? "");
      return isObject(value) ? value : {};
    } catch {
      return {};
    }
  };
  const object = (value: unknown) => (isObject(value) ? value : {});
  const items = (value: unknown): Record<string, unknown>[] =>
    Array.isArray(value) ? value.filter(isObject) : [];

  if (manifest.provider === "cloudflare") {
    const file = "worker/wrangler.json";
    const config = json(file);
    const db = items(config["d1_databases"]).filter(
      (entry) => entry["binding"] === "DB",
    );
    const bucket = items(config["r2_buckets"]).filter(
      (entry) => entry["binding"] === "BUCKET",
    );
    if (
      !isText(config["name"]) ||
      !isText(config["account_id"]) ||
      db.length !== 1 ||
      !isText(db[0]?.["database_id"]) ||
      bucket.length !== 1 ||
      !isText(bucket[0]?.["bucket_name"]) ||
      object(config["vars"])["BUCKET_NAME"] !== bucket[0]?.["bucket_name"] ||
      !Array.isArray(config["compatibility_flags"]) ||
      !config["compatibility_flags"].includes("nodejs_compat")
    ) {
      fail(
        "INFRA_CLOUDFLARE_BINDINGS",
        "Worker DB/BUCKET bindings or bucket settings are incomplete or inconsistent.",
        file,
        "Keep one DB binding, one BUCKET binding, matching vars.BUCKET_NAME, account/name and nodejs_compat.",
      );
    }
    const main = config["main"];
    try {
      if (!isText(main)) throw new Error("Missing entry point");
      await readScaffoldFile(infraDir, path.posix.join("worker", main));
    } catch {
      fail(
        "INFRA_RUNTIME_ENTRY",
        "The configured Worker entry point is missing or unsafe.",
        file,
        "Point main at the supplied Worker runtime inside this scaffold.",
      );
    }
  }
  if (manifest.provider === "supabase") {
    const file = "supabase/config.toml";
    let config: Record<string, unknown> = {};
    try {
      config = parseToml(contents.get(file) ?? "");
    } catch {
      fail(
        "INFRA_INVALID_TOML",
        "Deployment input is not valid TOML.",
        file,
        "Repair the TOML syntax in the Supabase deployment configuration.",
      );
    }
    if (
      !isText(config["project_id"]) ||
      object(object(config["functions"])["hot-updater-v1"])["verify_jwt"] !==
        false
    ) {
      fail(
        "INFRA_SUPABASE_FUNCTION",
        "The supplied Edge Function must use a project ID and verify_jwt = false.",
        file,
        "Configure project_id and [functions.hot-updater-v1]; the runtime authenticates the client x-api-key.",
      );
    }
  }
  if (manifest.provider === "aws") {
    const file = "cloudfront/distribution.json";
    const distribution = json(file);
    const behaviors = items(object(distribution["CacheBehaviors"])["Items"]);
    for (const route of ["/version", "/release-catalogs/*", "/artifacts/*"]) {
      const behavior = behaviors.find(
        (entry) => entry["PathPattern"] === route,
      );
      const lambdas = items(
        object(behavior?.["LambdaFunctionAssociations"])["Items"],
      );
      if (
        !behavior ||
        !isText(behavior["CachePolicyId"]) ||
        !lambdas.some(
          (entry) =>
            entry["EventType"] === "origin-request" &&
            isText(entry["LambdaFunctionARN"]),
        )
      ) {
        fail(
          "INFRA_AWS_ROUTE",
          `CloudFront ${route} needs its cache policy and origin-request Lambda.`,
          file,
          "Restore the supplied Hot Updater route and its qualified Lambda association.",
        );
      }
    }
    for (const policyFile of [
      "cloudfront/cache-policy.json",
      "cloudfront/catalog-cache-policy.json",
    ]) {
      const policy = object(json(policyFile)["CachePolicyConfig"]);
      const headers = object(
        object(policy["ParametersInCacheKeyAndForwardedToOrigin"])[
          "HeadersConfig"
        ],
      );
      const names = object(headers["Headers"])["Items"];
      if (
        headers["HeaderBehavior"] !== "whitelist" ||
        !Array.isArray(names) ||
        !names.includes("x-api-key")
      ) {
        fail(
          "INFRA_AWS_CACHE_AUTH",
          "CloudFront cache keys must include x-api-key.",
          policyFile,
          "Restore x-api-key in the cache policy header whitelist.",
        );
      }
    }
    if (!isText(json("dynamodb/create-table.json")["TableName"])) {
      fail(
        "INFRA_AWS_DATABASE",
        "The DynamoDB table input is missing its table name.",
        "dynamodb/create-table.json",
        "Use the selected DynamoDB table name.",
      );
    }
  }
  if (manifest.provider === "firebase") {
    if (!isText(object(json("firebase/.firebaserc")["projects"])["default"])) {
      fail(
        "INFRA_FIREBASE_PROJECT",
        "Firebase must select a project.",
        "firebase/.firebaserc",
        "Set projects.default to the selected project ID.",
      );
    }
    const functions = json("firebase/firebase.json")["functions"];
    const configs = Array.isArray(functions) ? functions : [functions];
    if (
      !configs.some(
        (entry) => isObject(entry) && entry["source"] === "functions",
      )
    ) {
      fail(
        "INFRA_FIREBASE_FUNCTION",
        "Firebase must deploy the supplied functions directory.",
        "firebase/firebase.json",
        "Restore the functions source from the supplied Firebase configuration.",
      );
    }
  }
  if (checks.every((check) => check.status === "pass")) {
    checks.push({
      code: "INFRA_SCAFFOLD",
      status: "pass",
      message:
        "Required files, deployment placeholders and provider configuration checks passed.",
    });
  }
  return { checks, manifest };
}
