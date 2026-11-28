import { type ChildProcess, execFile, spawn } from "node:child_process";
import http from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createConsoleInsightsHttpClient } from "../insights-http-client.ts";
import {
  closeLoopbackConnections,
  closeLoopbackConnectionsInProcess,
  headersForApp,
} from "./loopback-connections.ts";

// A provider whose event loop can stall for seconds. It advertises `Keep-Alive: timeout=4`, so fetch keeps an idle socket about 2 s
// and the server closes it 4 s after its last response.
const PROVIDER = `
const http = require("node:http");
let connections = 0;
const server = http.createServer((request, response) => {
  const url = new URL(request.url, "http://provider");
  if (url.pathname === "/stall") {
    process.stdout.write("stalling\\n");
    const end = Date.now() + Number(url.searchParams.get("ms"));
    while (Date.now() < end) {}
  }
  request.resume();
  request.on("end", () => {
    response.setHeader("content-type", "application/json");
    response.end(url.pathname === "/hot-updater/admin/events"
      ? JSON.stringify({ beforeReceivedAtMs: 0, data: [], nextCursor: null })
      : JSON.stringify({ connections }));
  });
});
server.keepAliveTimeout = 4000;
server.keepAliveTimeoutBuffer = 0;
server.on("connection", () => { connections += 1; });
server.listen(0, "127.0.0.1", () => {
  process.stdout.write("port " + server.address().port + "\\n");
});
`;
const STALL_MS = 5_000;

let provider: ChildProcess;
let baseUrl: string;

const nextLine = (match: RegExp): Promise<RegExpExecArray> =>
  new Promise((resolve) => {
    const onData = (chunk: Buffer) => {
      const found = match.exec(chunk.toString());
      if (found === null) return;
      provider.stdout?.off("data", onData);
      resolve(found);
    };
    provider.stdout?.on("data", onData);
  });

beforeAll(async () => {
  provider = spawn(process.execPath, ["-e", PROVIDER], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  const [, port] = await nextLine(/port (\d+)/);
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(() => {
  provider.kill();
});

/**
 * The failed run's sequence: the proxy's events POST leaves a socket, the
 * provider stalls past that socket's deadline, and Console Insights reads
 * while it stalls.
 */
async function readInsightsDuringStall(fetchImplementation: typeof fetch) {
  const event = await fetchImplementation(`${baseUrl}/hot-updater/events`, {
    body: "{}",
    method: "POST",
  });
  await event.text();
  const stalling = nextLine(/stalling/);
  // Its own connection, so the stall never touches the pooled socket.
  http
    .get(`${baseUrl}/stall?ms=${STALL_MS}`, { agent: false }, (response) =>
      response.resume(),
    )
    .on("error", () => {});
  await stalling;
  const client = createConsoleInsightsHttpClient({
    baseUrl: `${baseUrl}/hot-updater/admin`,
    fetch: fetchImplementation,
  });
  return client.listEvents({ limit: 50 });
}

describe("loopback connections under a provider stall", () => {
  it("a pooled socket is reset when the stall passes its deadline", async () => {
    const error = await readInsightsDuringStall(globalThis.fetch).then(
      () => null,
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(TypeError);
    expect((error as TypeError).cause).toMatchObject({ code: "ECONNRESET" });
    // Let the stall end so the next test starts on an idle provider.
    await sleep(500);
  }, 20_000);

  it("a new connection is answered after the stall", async () => {
    await expect(
      readInsightsDuringStall(closeLoopbackConnections(globalThis.fetch)),
    ).resolves.toEqual({ beforeReceivedAtMs: 0, data: [], nextCursor: null });
  }, 20_000);

  it("the controller's fetch opens a connection per request", async () => {
    const original = globalThis.fetch;
    const connections = async () =>
      ((await (await fetch(`${baseUrl}/`)).json()) as { connections: number })
        .connections;
    try {
      closeLoopbackConnectionsInProcess();
      // A pooled fetch reuses a socket by the third request.
      const first = await connections();
      await connections();
      expect(await connections()).toBe(first + 2);
    } finally {
      globalThis.fetch = original;
    }
  });
});

// Reads a 64 KiB body, undici's body high-water mark, from a Node server
// three times. The body stays unread while the server finishes the response,
// as when the asset proxy streams a bundle to an app that reads slower than
// the local storage writes. Prints the server's connection counts.
const SLOW_READER = `
import http from "node:http";
const { closeLoopbackConnections } = await import(process.env.LOOPBACK_MODULE);
const BODY_BYTES = 64 * 1024;
let opened = 0;
let closed = 0;
const server = http.createServer((request, response) => {
  request.resume();
  response.end(Buffer.alloc(BODY_BYTES));
});
server.on("connection", (socket) => {
  opened += 1;
  socket.on("close", () => { closed += 1; });
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const url = "http://127.0.0.1:" + server.address().port + "/";
const fetchBody = process.env.CLOSE_HEADER === "1"
  ? () => fetch(url, { headers: { connection: "close" } })
  : () => closeLoopbackConnections(fetch)(url);
for (let read = 0; read < 3; read += 1) {
  const response = await fetchBody();
  await new Promise((resolve) => setTimeout(resolve, 300));
  const bytes = (await response.arrayBuffer()).byteLength;
  if (bytes !== BODY_BYTES) throw new Error("short body " + bytes);
}
await new Promise((resolve) => setTimeout(resolve, 100));
process.stdout.write(JSON.stringify({ closed, opened }));
server.close();
`;

const readSlowly = (closeHeader: boolean) =>
  promisify(execFile)(
    process.execPath,
    ["--input-type=module", "-e", SLOW_READER],
    {
      env: {
        ...process.env,
        CLOSE_HEADER: closeHeader ? "1" : "0",
        LOOPBACK_MODULE: new URL("./loopback-connections.ts", import.meta.url)
          .href,
      },
    },
  );

describe("loopback connections under a slow reader", () => {
  it("a `connection: close` response crashes Node's fetch", async () => {
    const error = await readSlowly(true).then(
      () => null,
      (reason: unknown) => reason,
    );
    expect(error).toMatchObject({
      code: 1,
      stderr: expect.stringContaining("assert(!this.paused)"),
    });
  }, 20_000);

  it("the controller's fetch reads it and closes each connection", async () => {
    const { stdout } = await readSlowly(false);
    expect(JSON.parse(stdout)).toEqual({ closed: 3, opened: 3 });
  }, 20_000);
});

describe("closeLoopbackConnections", () => {
  const recordCall = (
    fetchImplementation = vi.fn<typeof fetch>(async () => new Response(null)),
  ) => {
    const dispatcher = {
      close: vi.fn(async () => {}),
      destroy: vi.fn(async () => {}),
    };
    return {
      dispatcher,
      fetch: closeLoopbackConnections(fetchImplementation, () => dispatcher),
      fetchImplementation,
      init: () => fetchImplementation.mock.calls[0]?.[1],
    };
  };

  it.each([
    "http://127.0.0.1:3007/hot-updater/admin/events",
    "http://localhost:3108/hot-updater/events",
    "http://127.1.2.3/",
    "http://[::1]:3007/",
  ])("gives the request to %s its own connection", async (url) => {
    const call = recordCall();
    await call.fetch(url, { headers: { accept: "application/json" } });
    expect(call.init()).toEqual({
      dispatcher: call.dispatcher,
      headers: { accept: "application/json" },
    });
    expect(call.dispatcher.close).toHaveBeenCalledOnce();
    expect(call.dispatcher.destroy).not.toHaveBeenCalled();
  });

  it("keeps a Request's own headers", async () => {
    const call = recordCall();
    const request = new Request("http://127.0.0.1:3007/", {
      headers: { "x-api-key": "k" },
    });
    await call.fetch(request);
    expect(call.fetchImplementation).toHaveBeenCalledWith(request, {
      dispatcher: call.dispatcher,
    });
  });

  it("destroys the connection of a failed request", async () => {
    const failure = new TypeError("fetch failed");
    const call = recordCall(
      vi.fn<typeof fetch>(async () => {
        throw failure;
      }),
    );
    await expect(call.fetch("http://127.0.0.1:3007/")).rejects.toBe(failure);
    expect(call.dispatcher.destroy).toHaveBeenCalledOnce();
    expect(call.dispatcher.close).not.toHaveBeenCalled();
  });

  it("leaves other hosts' requests unchanged", async () => {
    const call = recordCall();
    const init = { headers: { accept: "application/json" } };
    await call.fetch(
      "https://example.supabase.co/functions/v1/update-server",
      init,
    );
    expect(call.fetchImplementation).toHaveBeenCalledWith(
      "https://example.supabase.co/functions/v1/update-server",
      init,
    );
    expect(call.dispatcher.close).not.toHaveBeenCalled();
  });

  it("wraps the process's fetch once", () => {
    const original = globalThis.fetch;
    try {
      closeLoopbackConnectionsInProcess();
      const wrapped = globalThis.fetch;
      expect(wrapped).not.toBe(original);
      closeLoopbackConnectionsInProcess();
      expect(globalThis.fetch).toBe(wrapped);
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe("headersForApp", () => {
  it("drops the provider's connection headers", () => {
    const headers = headersForApp(
      new Headers({
        connection: "close",
        "content-type": "application/json",
        "keep-alive": "timeout=5",
      }),
    );
    expect([...headers.keys()]).toEqual(["content-type"]);
  });
});
