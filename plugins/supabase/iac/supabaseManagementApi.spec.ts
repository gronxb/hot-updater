import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  supabaseManagementApi,
  SUPABASE_MANAGEMENT_API_TIMEOUT_MS,
} from "./supabaseManagementApi";

const mockFetch = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", mockFetch);
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

const rejectWhenAborted = (_url: string, init?: RequestInit) =>
  new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
      once: true,
    });
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

  it("gets a project status", async () => {
    mockFetch.mockResolvedValue(
      new Response(JSON.stringify({ status: "COMING_UP" })),
    );

    await expect(
      supabaseManagementApi("access-token").getProjectStatus("project/ref"),
    ).resolves.toBe("COMING_UP");
    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.supabase.com/v1/projects/project%2Fref",
      expect.objectContaining({
        method: "GET",
        signal: expect.any(AbortSignal),
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

  it("stops a stalled read at the application deadline", async () => {
    vi.useFakeTimers();
    mockFetch.mockImplementation(rejectWhenAborted);

    const request = supabaseManagementApi("access-token").listOrganizations();
    const assertion = expect(request).rejects.toThrow(
      "Supabase Management API request timed out.",
    );
    await vi.advanceTimersByTimeAsync(SUPABASE_MANAGEMENT_API_TIMEOUT_MS);

    await assertion;
  });

  it("reports an ambiguous project creation timeout without retrying", async () => {
    vi.useFakeTimers();
    mockFetch.mockImplementation(rejectWhenAborted);

    const request = supabaseManagementApi("access-token").createProject({
      databasePassword: "database-password",
      name: "Hot Updater",
      organizationSlug: "team-slug",
      region: "us-east-1",
    });
    const assertion = expect(request).rejects.toThrow(
      "The request may have succeeded; check the organization's projects before retrying init.",
    );
    await vi.advanceTimersByTimeAsync(SUPABASE_MANAGEMENT_API_TIMEOUT_MS);

    await assertion;
    expect(mockFetch).toHaveBeenCalledOnce();
  });
});
