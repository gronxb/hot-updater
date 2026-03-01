import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { hdiff } from "../../../dist/node.js";

const port = readPortArg();

const [baseBytes, nextBytes] = await Promise.all([
  readFixture("one"),
  readFixture("two"),
]);

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);

  if (url.pathname === "/healthz") {
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("ok");
    return;
  }

  if (url.pathname !== "/demo/patch" || request.method !== "GET") {
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ code: "NOT_FOUND", message: "Not found" }));
    return;
  }

  try {
    const patch = await hdiff(baseBytes, nextBytes);
    const hash = await sha256Hex(patch);

    response.writeHead(200, {
      "content-type": "application/octet-stream",
      "content-disposition": 'attachment; filename="one-to-two.bsdiff"',
      "x-hdiff-patch-bytes": String(patch.byteLength),
      "x-hdiff-patch-sha256": hash,
    });
    response.end(Buffer.from(patch));
  } catch (error) {
    const err = error;
    const body =
      err instanceof Error
        ? { code: "INTERNAL_ERROR", message: err.message }
        : { code: "INTERNAL_ERROR", message: "Unknown error" };

    response.writeHead(500, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  }
});

server.listen(port, "127.0.0.1");

const close = () => {
  server.close(() => process.exit(0));
};

process.on("SIGINT", close);
process.on("SIGTERM", close);

async function readFixture(name) {
  const fileUrl = new URL(`../../../fixture/${name}/index.ios.bundle.hbc`, import.meta.url);
  return new Uint8Array(await readFile(fileUrl));
}

function readPortArg() {
  const index = process.argv.indexOf("--port");
  if (index === -1 || index + 1 >= process.argv.length) {
    throw new Error("Missing --port argument");
  }
  const parsed = Number(process.argv[index + 1]);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid --port value: ${process.argv[index + 1]}`);
  }
  return parsed;
}

async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join(
    ""
  );
}
