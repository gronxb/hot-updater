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
    "Inspect the target app directory, package manager, existing config and any previous deployment record. Ask only for missing provider/build choices and target account/project/region.",
    `Providers: ${INIT_PROVIDER_NAMES.join(", ")}. Builds: ${INFRA_BUILDS.join(", ")}.`,
    "",
    `Run hot-updater agent infra ${operation} --provider <provider> --build <build> from the app directory. Use --output <directory> for an unused custom destination, or --json for paths as JSON.`,
    "The server templates use the same extractor as hot-updater infra scaffold. Agent commands add instructions, app config and a deployment record.",
    "Read the returned instructions, COMMON.md, manifest.json and deployment.json. Fill the supplied templates and apply/verify one remote step at a time. Record actual resource IDs and query remote state before retrying a failed or unknown operation.",
    operation === "upgrade"
      ? "Read UPGRADE-NOTES.md for every transition between the deployed and target versions. Preserve resource IDs, data, secrets and customizations. v0-to-v1 requires a parallel namespace/endpoint and a new native app build; Supabase/Firebase can reuse their projects."
      : "Discover actual tool capabilities and ask for missing access. Scaffolding does not deploy resources or install packages. Continue with the provider guide to complete deployment and verification.",
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
