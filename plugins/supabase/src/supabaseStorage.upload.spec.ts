import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { supabaseStorage } from "./supabaseStorage";

/**
 * Uploads through supabase-js against a fake Storage endpoint, so a failed
 * request takes the path supabase-js takes for it: it reads the body of a
 * failed request as JSON.
 */
type Answer = Response | Error;
const requests: { method: string; url: string; body: string }[] = [];
let answers: Answer[] = [];

const htmlPage = (status: number) =>
  new Response(
    `<!DOCTYPE html><html><body><h1>${status} Bad Gateway</h1></body></html>`,
    { status, headers: { "content-type": "text/html" } },
  );
const stored = () =>
  Response.json({ Id: "id", Key: "updates/bundles/bundle.zip" });

beforeEach(() => {
  requests.length = 0;
  answers = [];
  vi.useFakeTimers({ toFake: ["setTimeout"] });
  vi.stubGlobal(
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit) => {
      // Read on every attempt, so a retry that sends an empty or locked body
      // shows here.
      requests.push({
        method: init?.method ?? "GET",
        url: String(input),
        body: init?.body == null ? "" : await new Response(init.body).text(),
      });
      const answer = answers.shift();
      if (answer === undefined) throw new Error("No answer left");
      if (answer instanceof Error) throw answer;
      return answer;
    },
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const storage = () =>
  supabaseStorage({
    bucketName: "updates",
    supabaseServiceRoleKey: "service-role-key",
    supabaseUrl: "https://example.supabase.co",
  });

const upload = async (
  body: string | ReadableStream<Uint8Array> = "bundle bytes",
  contentLength?: number,
) => {
  const stream = typeof body === "string" ? new Response(body).body! : body;
  const result = storage()
    .put({
      key: "bundles/bundle.zip",
      body: stream,
      contentType: "application/zip",
      ...(contentLength === undefined ? {} : { contentLength }),
    })
    .then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
  await vi.runAllTimersAsync();
  return result;
};

describe("supabaseStorage put", () => {
  it("sends the upload again after a gateway answers 502 with an HTML page", async () => {
    answers = [htmlPage(502), stored()];

    await expect(upload()).resolves.toEqual({
      value: { storageUri: "supabase-storage://updates/bundles/bundle.zip" },
    });
    expect(requests).toEqual([
      {
        method: "POST",
        url: "https://example.supabase.co/storage/v1/object/updates/bundles/bundle.zip",
        body: "bundle bytes",
      },
      {
        method: "POST",
        url: "https://example.supabase.co/storage/v1/object/updates/bundles/bundle.zip",
        body: "bundle bytes",
      },
    ]);
  });

  it("retries 429, a JSON 5xx, and a request Storage never answered", async () => {
    answers = [
      Response.json(
        { statusCode: "429", error: "too_many_requests", message: "Slow down" },
        { status: 429 },
      ),
      new TypeError("fetch failed"),
      stored(),
    ];
    await expect(upload()).resolves.toHaveProperty("value");
    expect(requests).toHaveLength(3);

    requests.length = 0;
    answers = [
      Response.json(
        { statusCode: "503", error: "unavailable", message: "Unavailable" },
        { status: 503 },
      ),
      stored(),
    ];
    await expect(upload()).resolves.toHaveProperty("value");
    expect(requests).toHaveLength(2);
  });

  it("names the HTTP status after three failed attempts", async () => {
    answers = [htmlPage(502), htmlPage(502), htmlPage(502)];

    const { error } = (await upload()) as { error: Error };

    expect(error.message).toBe(
      "Supabase Storage answered HTTP 502 while uploading bundles/bundle.zip",
    );
    expect(requests).toHaveLength(3);
  });

  it("says Storage never answered after three network failures", async () => {
    answers = [
      new TypeError("fetch failed"),
      new TypeError("fetch failed"),
      new TypeError("fetch failed"),
    ];

    const { error } = (await upload()) as { error: Error };

    expect(error.message).toBe(
      "Supabase Storage did not answer while uploading bundles/bundle.zip: fetch failed",
    );
    expect(requests).toHaveLength(3);
  });

  it("does not retry a 4xx other than 429, and keeps Storage's message", async () => {
    answers = [
      Response.json(
        {
          statusCode: "400",
          error: "InvalidKey",
          message: "Invalid key: bundles/bundle.zip",
        },
        { status: 400 },
      ),
    ];

    const { error } = (await upload()) as { error: Error };

    expect(error.message).toBe(
      "Supabase Storage answered HTTP 400 while uploading bundles/bundle.zip: Invalid key: bundles/bundle.zip",
    );
    expect(requests).toHaveLength(1);
  });

  it("streams a body over 16 MiB once, without retrying it", async () => {
    const size = 16 * 1024 * 1024 + 1;
    answers = [htmlPage(502)];

    const { error } = (await upload(
      new Response(new Uint8Array(size)).body!,
      size,
    )) as { error: Error };

    expect(error.message).toBe(
      "Supabase Storage answered HTTP 502 while uploading bundles/bundle.zip",
    );
    expect(requests).toHaveLength(1);
    expect(requests[0]?.body).toHaveLength(size);
  });

  it("streams a body of unknown length over 16 MiB with all its bytes", async () => {
    const chunk = new Uint8Array(1024 * 1024).fill(97);
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent === 17) controller.close();
        else {
          sent++;
          controller.enqueue(chunk);
        }
      },
    });
    answers = [stored()];

    await expect(upload(body)).resolves.toHaveProperty("value");
    expect(requests).toHaveLength(1);
    expect(requests[0]?.body).toBe("a".repeat(17 * 1024 * 1024));
  });
});
