import {
  handleInfraScaffold,
  INFRA_BUILDS,
  type InfraOptions,
} from "../infra/scaffold";
import { INIT_PROVIDER_NAMES } from "../initProviders";

type AgentInfraOperation = "setup" | "upgrade";

export const infraBootstrap = (operation: AgentInfraOperation) =>
  [
    `# Hot Updater agent infrastructure ${operation}`,
    "",
    "Generate deployment templates and instructions, then apply them using your available provider MCP, CLI/API, or browser tools.",
    "Discover the target app in the workspace, package manager, build plugin, existing config and previous deployment record. Query available provider access and resources. Infer choices from this evidence; ask only when the target remains ambiguous or required access is unavailable.",
    "Before remote changes, arrange Node 22.18+ or Node 24+ for app/provision-api-key.mjs, which imports TypeScript; the CLI itself supports Node 20.19+. Check local package-manager tooling.",
    `Providers: ${INIT_PROVIDER_NAMES.join(", ")}. Builds: ${INFRA_BUILDS.join(", ")}.`,
    "",
    `Run hot-updater agent infra ${operation} --provider <provider> --build <build> from the app directory. Use --output <directory> for an unused custom destination, or --json for paths as JSON.`,
    "The server templates use the same extractor as hot-updater infra scaffold. Agent commands add instructions, app config and a deployment record.",
    "Read the returned instructions, COMMON.md, ENVIRONMENT.md, manifest.json and deployment.json. Create missing projects/instances/resources needed for the requested setup with authorized provider tools. For setup follow SETUP.md in order; for upgrade follow the applicable version files and use SETUP.md only for required prerequisites. Verify prerequisites, apply the action, verify the result, then record evidence. Save pendingStep with a stable target before each remote mutation and resolve it before retrying. Finish the common.verify, common.local and common.report checks in COMMON.md; app/verify-server.mjs checks server version and catalog authentication without exposing keys.",
    "ENVIRONMENT.md explains each variable's purpose, conditions and source. Never request secrets in chat: use provider login or ask the user to save credentials directly in a private local file, then verify access without printing values. Do not require users to fill fields or create resources the agent can discover or prepare.",
    operation === "upgrade"
      ? "Read upgrades/README.md and all relevant upgrades/<version>.md files in ascending order before applying changes. Include the installed generation's baseline as context and every later requirement through the target. Preserve resource IDs, data, secrets and customizations."
      : 'Discover actual tool capabilities and ask for missing access. Scaffolding does not deploy resources or install packages. Continue with the provider guide to complete deployment and verification. Provision or reuse the client API key. Finish with a ready-to-copy HotUpdater.init snippet containing the verified baseURL and actual registered client key in requestHeaders["x-api-key"], as described in common.report. Keep provider, service-role, admin and signing credentials private.',
  ].join("\n");

export async function handleAgentInfra(
  operation: AgentInfraOperation,
  options: InfraOptions,
) {
  if (!options.provider || !options.build) {
    const instructions = infraBootstrap(operation);
    console.log(
      options.json
        ? JSON.stringify({
            status: "needs-input",
            operation,
            providers: INIT_PROVIDER_NAMES,
            builds: INFRA_BUILDS,
            instructions,
          })
        : instructions,
    );
    return;
  }
  await handleInfraScaffold(operation, options);
}
