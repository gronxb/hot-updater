import {
  assertInfrastructureGenerationPayload,
  InitError,
} from "@hot-updater/cli-tools";

import type { VercelApi, VercelProject } from "./vercelApi";

/** The URL devices reach the project's production Function at. */
export const productionBaseUrl = (project: VercelProject) => {
  const alias =
    project.productionAliases.find(
      (domain) => domain === `${project.name}.vercel.app`,
    ) ??
    project.productionAliases.find((domain) =>
      domain.endsWith(".vercel.app"),
    ) ??
    project.productionAliases[0];
  if (alias === undefined) {
    throw new InitError(
      `Vercel assigned project ${project.name} no production domain.`,
    );
  }
  return `https://${alias}`;
};

/**
 * Init replaces the project's production deployment, so it reuses only a
 * project it set up before (the saved ID, or one whose production answers
 * Hot Updater's `/version`) or one that has never deployed to production.
 */
export const assertVercelProjectCanHostFunction = async ({
  api,
  fetchImpl = fetch,
  project,
  savedProjectId,
}: {
  readonly api: Pick<VercelApi, "hasProductionDeployment">;
  readonly fetchImpl?: typeof fetch;
  readonly project: VercelProject;
  readonly savedProjectId?: string;
}) => {
  if (project.id === savedProjectId) return;
  if (!(await api.hasProductionDeployment(project.id))) return;

  const refuse = () =>
    new InitError(
      `Vercel project ${project.name} already serves another app in production. Choose another project name, or remove its production deployment, then rerun init.`,
    );
  let payload: unknown;
  try {
    const response = await fetchImpl(`${productionBaseUrl(project)}/version`);
    if (!response.ok) throw refuse();
    payload = await response.json();
  } catch {
    throw refuse();
  }
  try {
    assertInfrastructureGenerationPayload({
      payload,
      provider: "Vercel",
      resource: `project ${project.name}`,
    });
  } catch {
    throw refuse();
  }
};
