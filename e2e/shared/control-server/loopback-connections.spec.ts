import { type ChildProcess, spawn } from "node:child_process";
import http from "node:http";
import { setTimeout as sleep } from "node:timers/promises";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createConsoleInsightsHttpClient } from "../insights-http-client.ts";
import {
  closeLoopbackConnections,
  closeLoopbackConnectionsInProcess,
  headersForApp,
} from "./loopback-connections.ts";

// A provider whose event loop can stall, as PGlite does while it writes. It
// advertises `Keep-Alive: timeout=4`, so fetch keeps an idle socket about 2 s
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

  it("a closed connection is answered after the stall", async () => {
    await expect(
      readInsightsDuringStall(closeLoopbackConnections(globalThis.fetch)),
    ).resolves.toEqual({ beforeReceivedAtMs: 0, data: [], nextCursor: null });
  }, 20_000);
});

describe("closeLoopbackConnections", () => {
  const recordCall = () => {
    const fetchImplementation = vi.fn<typeof fetch>(
      async () => new Response(null),
    );
    return {
      fetchImplementation,
      headers: () =>
        new Headers(fetchImplementation.mock.calls[0]?.[1]?.headers),
    };
  };

  it.each([
    "http://127.0.0.1:3007/hot-updater/admin/events",
    "http://localhost:3108/hot-updater/events",
    "http://127.1.2.3/",
    "http://[::1]:3007/",
  ])("closes the connection to %s", async (url) => {
    const call = recordCall();
    await closeLoopbackConnections(call.fetchImplementation)(url, {
      headers: { accept: "application/json" },
    });
    expect(call.headers().get("connection")).toBe("close");
    expect(call.headers().get("accept")).toBe("application/json");
  });

  it("keeps a Request's own headers", async () => {
    const call = recordCall();
    await closeLoopbackConnections(call.fetchImplementation)(
      new Request("http://127.0.0.1:3007/", { headers: { "x-api-key": "k" } }),
    );
    expect(call.headers().get("connection")).toBe("close");
    expect(call.headers().get("x-api-key")).toBe("k");
  });

  it("leaves other hosts' requests unchanged", async () => {
    const call = recordCall();
    const init = { headers: { accept: "application/json" } };
    await closeLoopbackConnections(call.fetchImplementation)(
      "https://example.supabase.co/functions/v1/update-server",
      init,
    );
    expect(call.fetchImplementation).toHaveBeenCalledWith(
      "https://example.supabase.co/functions/v1/update-server",
      init,
    );
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
