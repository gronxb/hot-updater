import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { supabaseStorage } from "./supabaseStorage";

/**
 * Uploads through supabase-js with a stubbed fetch, so a failed request takes
 * the path supabase-js takes for it: it reads the body of a failed request as
 * JSON.
 */
const requests: { method: string; body: string }[] = [];
let answer: () => Response;

beforeEach(() => {
  requests.length = 0;
  vi.stubGlobal(
    "fetch",
    async (_input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({
        method: init?.method ?? "GET",
        body: init?.body == null ? "" : await new Response(init.body).text(),
      });
      return answer();
    },
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const upload = () =>
  supabaseStorage({
    bucketName: "updates",
    supabaseServiceRoleKey: "service-role-key",
    supabaseUrl: "https://example.supabase.co",
  }).put({
    key: "bundles/bundle.zip",
    body: new Response("bundle bytes").body!,
    contentLength: 12,
    contentType: "application/zip",
  });

describe("supabaseStorage put", () => {
  it("fails once with the HTTP status when a gateway answers 502 with an HTML page", async () => {
    answer = () =>
      new Response("<!DOCTYPE html><html><body>502 Bad Gateway</body></html>", {
        status: 502,
        headers: { "content-type": "text/html" },
      });

    await expect(upload()).rejects.toThrow(
      /^Supabase Storage answered HTTP 502 while uploading bundles\/bundle\.zip$/,
    );
    expect(requests).toEqual([{ method: "POST", body: "bundle bytes" }]);
  });

  it("keeps Storage's message for a refused upload", async () => {
    answer = () =>
      Response.json(
        {
          statusCode: "413",
          error: "Payload too large",
          message: "The object exceeded the maximum allowed size",
        },
        { status: 413 },
      );

    await expect(upload()).rejects.toThrow(
      /^Supabase Storage answered HTTP 413 while uploading bundles\/bundle\.zip: The object exceeded the maximum allowed size$/,
    );
    expect(requests).toHaveLength(1);
  });
});
