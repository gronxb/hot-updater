import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { supabaseManagementApi } from "./supabaseManagementApi";

const mockFetch = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", mockFetch);
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("supabaseManagementApi", () => {
  it("lists organizations with the access token in a header", async () => {
    mockFetch.mockResolvedValue(
      new Response(
        JSON.stringify([{ id: "org-id", name: "Team", slug: "team-slug" }]),
      ),
    );

    await expect(
      supabaseManagementApi("access-token").listOrganizations(),
    ).resolves.toEqual([{ id: "org-id", name: "Team", slug: "team-slug" }]);
    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.supabase.com/v1/organizations",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer access-token",
        }),
        method: "GET",
      }),
    );
  });

  it("creates a project without putting credentials in command arguments", async () => {
    mockFetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          name: "Hot Updater",
          ref: "project-ref",
          region: "us-east-1",
        }),
        { status: 201 },
      ),
    );

    await expect(
      supabaseManagementApi("access-token").createProject({
        databasePassword: "database-password",
        name: "Hot Updater",
        organizationSlug: "team-slug",
        region: "us-east-1",
      }),
    ).resolves.toEqual({
      id: "project-ref",
      name: "Hot Updater",
      region: "us-east-1",
    });
    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.supabase.com/v1/projects",
      expect.objectContaining({
        body: JSON.stringify({
          db_pass: "database-password",
          name: "Hot Updater",
          organization_slug: "team-slug",
          region: "us-east-1",
        }),
        headers: expect.objectContaining({
          Authorization: "Bearer access-token",
        }),
        method: "POST",
      }),
    );
  });

  it("does not include credentials in request failures", async () => {
    mockFetch.mockResolvedValue(new Response("", { status: 403 }));

    const createProject = supabaseManagementApi(
      "secret-access-token",
    ).createProject({
      databasePassword: "secret-database-password",
      name: "Hot Updater",
      organizationSlug: "team-slug",
      region: "us-east-1",
    });

    await expect(createProject).rejects.toThrow(
      "Supabase Management API request failed with status 403.",
    );
    await expect(createProject).rejects.not.toThrow("secret");
  });
});
