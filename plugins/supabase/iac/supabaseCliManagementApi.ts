import { execa } from "execa";

import type {
  SupabaseManagementApi,
  SupabaseOrganization,
} from "./supabaseManagementApi";

class SupabaseCliResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SupabaseCliResponseError";
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const runSupabaseCli = async (args: readonly string[]): Promise<unknown> => {
  const result = await execa("npx", ["-y", "supabase", ...args], {
    env: undefined,
  });
  const body: unknown = JSON.parse(result.stdout);
  return body;
};

export const supabaseCliManagementApi = (): SupabaseManagementApi => ({
  listOrganizations: async () => {
    const body = await runSupabaseCli(["orgs", "list", "--output", "json"]);
    if (!Array.isArray(body)) {
      throw new SupabaseCliResponseError(
        "Supabase organizations response was invalid.",
      );
    }

    return body.flatMap(
      (organization: unknown): readonly SupabaseOrganization[] =>
        isRecord(organization) &&
        typeof organization.id === "string" &&
        typeof organization.name === "string" &&
        typeof organization.slug === "string"
          ? [
              {
                id: organization.id,
                name: organization.name,
                slug: organization.slug,
              },
            ]
          : [],
    );
  },
  createProject: async ({ name, organizationSlug, region }) => {
    await execa(
      "npx",
      [
        "-y",
        "supabase",
        "projects",
        "create",
        name,
        "--org-id",
        organizationSlug,
        "--region",
        region,
        "--agent",
        "no",
      ],
      {
        stdio: "inherit",
      },
    );
    const body = await runSupabaseCli(["projects", "list", "--output", "json"]);
    if (!Array.isArray(body)) {
      throw new SupabaseCliResponseError(
        "Supabase projects response was invalid after project creation.",
      );
    }

    const project = body.find(
      (candidate: unknown) =>
        isRecord(candidate) &&
        candidate.name === name &&
        candidate.organization_slug === organizationSlug &&
        candidate.region === region,
    );
    if (
      !isRecord(project) ||
      typeof project.id !== "string" ||
      typeof project.name !== "string" ||
      typeof project.region !== "string"
    ) {
      throw new SupabaseCliResponseError(
        "Created Supabase project was not found.",
      );
    }
    return {
      id: project.id,
      name: project.name,
      region: project.region,
    };
  },
  getProjectStatus: async (projectId) => {
    const body = await runSupabaseCli(["projects", "list", "--output", "json"]);
    if (!Array.isArray(body)) {
      throw new SupabaseCliResponseError(
        "Supabase projects response was invalid.",
      );
    }

    const project = body.find(
      (candidate: unknown) =>
        isRecord(candidate) &&
        (candidate.id === projectId || candidate.ref === projectId),
    );
    if (!isRecord(project) || typeof project.status !== "string") {
      throw new SupabaseCliResponseError(
        "Supabase project status was not found.",
      );
    }
    return project.status;
  },
});
