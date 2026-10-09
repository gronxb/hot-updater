import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { plugins } from "../../src/plugins";

const mocks = vi.hoisted(() => {
  const client = vi.fn<(request: Request) => Promise<Response>>();
  return {
    client,
    createHotUpdater: vi.fn((_options: unknown) => ({ handlers: { client } })),
  };
});

// The server's client routes, which answer as each case needs.
vi.mock("@hot-updater/server", () => ({
  createHotUpdater: mocks.createHotUpdater,
}));

type FunctionHandler = (request: unknown, response: unknown) => unknown;

let handler: FunctionHandler;

beforeAll(async () => {
  // The project and default bucket Firebase configures for the function,
  // and the region init writes into it.
  vi.stubEnv(
    "FIREBASE_CONFIG",
    JSON.stringify({
      projectId: "demo-hot-updater",
      storageBucket: "demo-hot-updater.appspot.com",
    }),
  );
  vi.stubGlobal("HotUpdater", { REGION: "us-central1" });
  const { hot } = await import("./index");
  handler = hot.updater.v1 as unknown as FunctionHandler;
});

afterAll(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

/** What the function sends for a GET of `urlPath`. */
const get = async (urlPath: string) => {
  const sent: {
    status?: number;
    headers: Record<string, unknown>;
    body?: Buffer;
  } = { headers: {} };
  await handler(
    {
      hostname: "us-central1-demo-hot-updater.cloudfunctions.net",
      originalUrl: urlPath,
      method: "GET",
      headers: {},
    },
    {
      status: (status: number) => {
        sent.status = status;
      },
      setHeader: (key: string, value: unknown) => {
        sent.headers[key] = value;
      },
      send: (body: Buffer) => {
        sent.body = body;
      },
    },
  );
  return sent;
};

describe("the prebuilt Cloud Function", () => {
  it("runs the package's plugins over its project's Firestore and default bucket", () => {
    expect(mocks.createHotUpdater).toHaveBeenCalledOnce();
    expect(mocks.createHotUpdater.mock.calls[0]?.[0]).toMatchObject({
      database: { name: "firebaseDatabase" },
      storage: { name: "firebaseStorage", protocol: "gs" },
      plugins,
    });
  });

  it("answers the health check itself", async () => {
    const response = await get("/ping");

    expect(response.status).toBe(200);
    expect(response.body?.toString()).toBe("pong");
    expect(mocks.client).not.toHaveBeenCalled();
  });

  it("sends a route's response as its bytes, with each of its cookies", async () => {
    mocks.client.mockImplementationOnce(async () => {
      const headers = new Headers({
        "content-type": "application/octet-stream",
      });
      headers.append("set-cookie", "a=1; Path=/");
      headers.append("set-cookie", "b=2; Path=/");
      return new Response(new Uint8Array([0, 255, 128, 10]), { headers });
    });

    const response = await get("/storage/token/signature");

    expect(mocks.client).toHaveBeenCalledOnce();
    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toBe("application/octet-stream");
    expect(response.body).toEqual(Buffer.from([0, 255, 128, 10]));
    expect(response.headers["set-cookie"]).toEqual([
      "a=1; Path=/",
      "b=2; Path=/",
    ]);
  });
});
