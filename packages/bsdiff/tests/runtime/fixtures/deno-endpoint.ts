import { hdiff } from "../../../dist/deno.js";

const port = readPortArg();

const [baseBytes, nextBytes] = await Promise.all([
  readFixture("one"),
  readFixture("two"),
]);

const abortController = new AbortController();
const serverPromise = Deno.serve(
  { hostname: "127.0.0.1", port, signal: abortController.signal },
  async (request) => {
    const url = new URL(request.url);

    if (url.pathname === "/healthz") {
      return new Response("ok");
    }

    if (url.pathname !== "/demo/patch" || request.method !== "GET") {
      return Response.json(
        { code: "NOT_FOUND", message: "Not found" },
        { status: 404 },
      );
    }

    try {
      const patch = await hdiff(baseBytes, nextBytes);
      const hash = await sha256Hex(patch);

      return new Response(patch, {
        status: 200,
        headers: {
          "content-type": "application/octet-stream",
          "content-disposition": 'attachment; filename="one-to-two.bsdiff"',
          "x-hdiff-patch-bytes": String(patch.byteLength),
          "x-hdiff-patch-sha256": hash,
        },
      });
    } catch (error) {
      const err = error as { message?: string };
      return Response.json(
        {
          code: "INTERNAL_ERROR",
          message: err.message ?? "Unknown error",
        },
        { status: 500 },
      );
    }
  },
);

const close = () => {
  abortController.abort();
};

Deno.addSignalListener("SIGINT", close);
Deno.addSignalListener("SIGTERM", close);

await serverPromise;

async function readFixture(name: "one" | "two"): Promise<Uint8Array> {
  const bytes = await Deno.readFile(
    new URL(`../../../fixture/${name}/index.ios.bundle.hbc`, import.meta.url),
  );
  return new Uint8Array(bytes);
}

function readPortArg(): number {
  const index = Deno.args.indexOf("--port");
  if (index === -1 || index + 1 >= Deno.args.length) {
    throw new Error("Missing --port argument");
  }
  const parsed = Number(Deno.args[index + 1]);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid --port value: ${Deno.args[index + 1]}`);
  }
  return parsed;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (value) =>
    value.toString(16).padStart(2, "0"),
  ).join("");
}
