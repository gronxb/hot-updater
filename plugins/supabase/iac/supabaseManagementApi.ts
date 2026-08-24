import type { SupabaseRegion } from "./init/index";
import { supabaseCliManagementApi } from "./supabaseCliManagementApi";

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
  listFunctions: (projectId: string) => Promise<readonly string[]>;
  listOrganizations: () => Promise<readonly SupabaseOrganization[]>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

export const parseSupabaseFunctionSlugs = (
  body: unknown,
): readonly string[] => {
  if (!Array.isArray(body)) {
    throw new Error("Supabase functions response was invalid.");
  }
  return body.map((item) => {
    if (!isRecord(item) || typeof item.slug !== "string") {
      throw new Error("Supabase functions response was invalid.");
    }
    return item.slug;
  });
};

class SupabaseManagementApiStatusError extends Error {}

const projectCreationMayHaveSucceededError = (
  message = "Supabase project creation could not be confirmed.",
  cause?: unknown,
) =>
  new Error(
    `${message} The request may have succeeded; check the organization's projects before retrying init.`,
    { cause },
  );

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
  try {
    const response = await fetch(`${SUPABASE_MANAGEMENT_API_URL}${path}`, {
      body: init?.body ? JSON.stringify(init.body) : undefined,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      method,
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new SupabaseManagementApiStatusError(
        `Supabase Management API request failed with status ${response.status}.`,
      );
    }

    const body: unknown = await response.json();
    return body;
  } catch (error) {
    if (!controller.signal.aborted) {
      if (
        method === "POST" &&
        !(error instanceof SupabaseManagementApiStatusError)
      ) {
        throw projectCreationMayHaveSucceededError(undefined, error);
      }
      throw error;
    }
    if (method === "POST") {
      throw projectCreationMayHaveSucceededError(
        "Supabase project creation timed out.",
        error,
      );
    }
    throw new Error("Supabase Management API request timed out.");
  } finally {
    clearTimeout(timeout);
  }
};

export const supabaseManagementApi = (
  accessToken?: string,
): SupabaseManagementApi =>
  accessToken === undefined
    ? supabaseCliManagementApi()
    : {
        listOrganizations: async () => {
          const body = await request(accessToken, "/organizations");
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
        listFunctions: async (projectId) =>
          parseSupabaseFunctionSlugs(
            await request(
              accessToken,
              `/projects/${encodeURIComponent(projectId)}/functions`,
            ),
          ),
        createProject: async ({
          databasePassword,
          name,
          organizationSlug,
          region,
        }) => {
          const body = await request(accessToken, "/projects", {
            body: {
              db_pass: databasePassword,
              name,
              organization_slug: organizationSlug,
              region,
            },
            method: "POST",
          });
          if (
            !isRecord(body) ||
            typeof body.ref !== "string" ||
            typeof body.name !== "string" ||
            typeof body.region !== "string"
          ) {
            throw projectCreationMayHaveSucceededError(
              "Supabase project creation response was invalid.",
            );
          }

          return {
            id: body.ref,
            name: body.name,
            region: body.region,
          };
        },
        getProjectStatus: async (projectId) => {
          const body = await request(
            accessToken,
            `/projects/${encodeURIComponent(projectId)}`,
          );
          if (!isRecord(body) || typeof body.status !== "string") {
            throw new Error("Supabase project response was invalid.");
          }

          return body.status;
        },
      };
