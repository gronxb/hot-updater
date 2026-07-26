import type { SupabaseRegion } from "@hot-updater/cli-tools";

const SUPABASE_MANAGEMENT_API_URL = "https://api.supabase.com/v1";
export const SUPABASE_MANAGEMENT_API_TIMEOUT_MS = 30_000;

export type SupabaseOrganization = {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
};

export type SupabaseProject = {
  readonly id: string;
  readonly name: string;
  readonly region: string;
};

export interface SupabaseManagementApi {
  createProject: (input: {
    readonly databasePassword: string;
    readonly name: string;
    readonly organizationSlug: string;
    readonly region: SupabaseRegion;
  }) => Promise<SupabaseProject>;
  getProjectStatus: (projectId: string) => Promise<string>;
  listOrganizations: () => Promise<readonly SupabaseOrganization[]>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const request = async (
  accessToken: string,
  path: string,
  init?: {
    readonly body?: Readonly<Record<string, string>>;
    readonly method?: "GET" | "POST";
  },
) => {
  const method = init?.method ?? "GET";
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    SUPABASE_MANAGEMENT_API_TIMEOUT_MS,
  );
  timeout.unref();
  let response: Response;
  try {
    response = await fetch(`${SUPABASE_MANAGEMENT_API_URL}${path}`, {
      body: init?.body ? JSON.stringify(init.body) : undefined,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      method,
      signal: controller.signal,
    });
  } catch (error) {
    if (!controller.signal.aborted) {
      throw error;
    }
    if (method === "POST") {
      throw new Error(
        "Supabase project creation timed out. The request may have succeeded; check the organization's projects before retrying init.",
      );
    }
    throw new Error("Supabase Management API request timed out.");
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    throw new Error(
      `Supabase Management API request failed with status ${response.status}.`,
    );
  }

  return response;
};

export const supabaseManagementApi = (
  accessToken: string,
): SupabaseManagementApi => ({
  listOrganizations: async () => {
    const response = await request(accessToken, "/organizations");
    const body: unknown = await response.json();
    if (!Array.isArray(body)) {
      throw new Error("Supabase organizations response was invalid.");
    }

    return body.flatMap((organization) =>
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
  createProject: async ({
    databasePassword,
    name,
    organizationSlug,
    region,
  }) => {
    const response = await request(accessToken, "/projects", {
      body: {
        db_pass: databasePassword,
        name,
        organization_slug: organizationSlug,
        region,
      },
      method: "POST",
    });
    const body: unknown = await response.json();
    if (
      !isRecord(body) ||
      typeof body.ref !== "string" ||
      typeof body.name !== "string" ||
      typeof body.region !== "string"
    ) {
      throw new Error("Supabase project creation response was invalid.");
    }

    return {
      id: body.ref,
      name: body.name,
      region: body.region,
    };
  },
  getProjectStatus: async (projectId) => {
    const response = await request(
      accessToken,
      `/projects/${encodeURIComponent(projectId)}`,
    );
    const body: unknown = await response.json();
    if (!isRecord(body) || typeof body.status !== "string") {
      throw new Error("Supabase project response was invalid.");
    }

    return body.status;
  },
});
