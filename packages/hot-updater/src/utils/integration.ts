import type { ConfigResponse } from "@hot-updater/cli-tools";
import { getCwd } from "@hot-updater/cli-tools";
import type { BuildPlugin, IntegrationCommand } from "@hot-updater/plugin-core";

export async function runIntegrationCommand(
  config: ConfigResponse,
  command: IntegrationCommand,
  buildPlugin?: BuildPlugin,
): Promise<BuildPlugin> {
  const integration = buildPlugin ?? (await config.build({ cwd: getCwd() }));
  await integration.integration?.beforeCommand?.({ command });
  return integration;
}
