import path from "node:path";

import { type DoctorCheck, isObject } from "./checks";
import { checkScaffold, readScaffoldFile } from "./scaffold";
import { verifyServer } from "./server";

export interface VerificationOptions {
  scope?: "scaffold" | "infrastructure";
  infraDir?: string;
  platform?: string;
  channel?: string;
  appVersion?: string;
  fingerprint?: string;
}

export interface DoctorVerification {
  schemaVersion: 1;
  scope: "scaffold" | "infrastructure";
  checks: DoctorCheck[];
  notChecked: string[];
}

export const hasVerificationOptions = (options: VerificationOptions) =>
  [
    options.scope,
    options.infraDir,
    options.platform,
    options.channel,
    options.appVersion,
    options.fingerprint,
  ].some((value) => value !== undefined);

export async function verifyInfrastructure(
  options: VerificationOptions & {
    cwd: string;
    serverBaseUrl?: string;
    fetch?: typeof fetch;
  },
): Promise<DoctorVerification> {
  const checks: DoctorCheck[] = [];
  const result: DoctorVerification = {
    schemaVersion: 1,
    scope: options.scope ?? "scaffold",
    checks,
    notChecked: [
      "app-cli-packages-and-config",
      "remote-resource-bindings-and-migrations",
      "local-storage-credentials-and-write-access",
      "artifact-downloads",
      "app-js-and-native-integration",
      "native-ota",
      ...(options.scope === "infrastructure" ? [] : ["live-server"]),
    ],
  };
  if (!options.scope || !options.infraDir) {
    checks.push({
      code: "INFRA_TARGET_REQUIRED",
      status: "blocked",
      message:
        "Select --scope scaffold|infrastructure and --infra-dir <directory>.",
      fixability: "command",
      resolution:
        "Use the exact scaffold directory returned by infra scaffold or agent infra setup/upgrade.",
    });
    return result;
  }
  const infraDir = path.resolve(options.cwd, options.infraDir);
  let manifest;
  try {
    const scaffold = await checkScaffold(infraDir);
    checks.push(...scaffold.checks);
    manifest = scaffold.manifest;
  } catch {
    checks.push({
      code: "INFRA_TEMPLATE_UNAVAILABLE",
      status: "blocked",
      message: "Cannot read this CLI's packaged infrastructure templates.",
      fixability: "command",
      resolution: "Reinstall the selected CLI version before retrying doctor.",
    });
  }
  if (options.scope === "scaffold") return result;

  if (manifest && manifest.operation !== "scaffold") {
    try {
      const record: unknown = JSON.parse(
        await readScaffoldFile(infraDir, "deployment.json"),
      );
      if (
        !isObject(record) ||
        record["schemaVersion"] !== 1 ||
        record["provider"] !== manifest.provider ||
        record["pendingStep"] !== null
      ) {
        throw new Error("Unresolved deployment");
      }
      if (
        record["baseUrl"] != null &&
        (typeof record["baseUrl"] !== "string" ||
          record["baseUrl"].replace(/\/+$/, "") !==
            options.serverBaseUrl?.replace(/\/+$/, ""))
      ) {
        throw new Error("Target mismatch");
      }
      checks.push({
        code: "INFRA_DEPLOYMENT_TARGET",
        status: "pass",
        message:
          "Deployment record has no unresolved operation or conflicting endpoint. Live checks are still required.",
      });
    } catch {
      checks.push({
        code: "INFRA_DEPLOYMENT_UNRESOLVED",
        status: "blocked",
        paths: ["deployment.json"],
        message:
          "Deployment record is invalid, has a pending operation or conflicts with the selected endpoint.",
        fixability: "blocked",
        resolution:
          "Observe the pending operation's actual outcome and reconcile the selected target before retrying. Recorded verifiedSteps cannot replace live checks.",
      });
    }
  }

  const stages = [
    "inputs",
    "version",
    "anonymous-catalog",
    "authenticated-catalog",
  ] as const;
  const codes = [
    "INFRA_SERVER_INPUTS",
    "INFRA_SERVER_VERSION",
    "INFRA_ANONYMOUS_CATALOG",
    "INFRA_AUTHENTICATED_CATALOG",
  ] as const;
  if (!manifest || checks.some((check) => check.status !== "pass")) {
    checks.push(
      ...codes.map(
        (code): DoctorCheck => ({
          code,
          status: "blocked",
          message:
            "Resolve the scaffold or deployment prerequisite before probing the server.",
          fixability: "blocked",
        }),
      ),
    );
    return result;
  }
  const probe = await verifyServer({
    ...options,
    infraDir,
    baseUrl: options.serverBaseUrl,
    serverVersion: manifest.serverVersion,
    infrastructureGeneration: manifest.infrastructureGeneration,
  });
  const failedAt =
    probe.status === "failed" ? stages.indexOf(probe.check) : stages.length;
  for (const [index, code] of codes.entries()) {
    if (index < failedAt) {
      checks.push({
        code,
        status: "pass",
        message: `${stages[index]} verified.`,
      });
    } else if (index === failedAt && probe.status === "failed") {
      checks.push({
        code,
        status: index === 0 ? "blocked" : "fail",
        message: probe.error,
        fixability: "blocked",
        resolution:
          index === 0
            ? "Provide --server-base-url, --platform, --channel and exactly one of --app-version/--fingerprint. Store the client key in the local environment or scaffold app/api-key.local."
            : "Inspect the selected deployment, routing and client-key registration, then rerun the same doctor command.",
      });
    } else {
      checks.push({
        code,
        status: "blocked",
        message: "A preceding server check did not pass.",
        fixability: "blocked",
      });
    }
  }
  return result;
}
