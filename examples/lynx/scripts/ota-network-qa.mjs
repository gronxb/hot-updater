import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  createStorageUri,
  parseStorageUri,
} from "../../../plugins/plugin-core/dist/index.mjs";

// Negative transport controls are separate from the live catalog/storage service.
const root = fileURLToPath(new URL("../.hot-updater/ota/", import.meta.url));
const port = 18792;
const origin = `http://127.0.0.1:${port}`;
const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, origin);
    if (url.pathname === "/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ status: "ready", pid: process.pid, port }));
      return;
    }
    const match = /^\/qa\/(slow|truncated)\/(.+)$/.exec(url.pathname);
    if (request.method !== "GET" || !match) {
      response.writeHead(404).end();
      return;
    }
    const key = match[2].split("/").map(decodeURIComponent).join("/");
    const uri = createStorageUri({
      protocol: "lynx-local",
      bucket: "ota",
      key,
    });
    const parsed = parseStorageUri(uri, "lynx-local");
    const bytes = await fs.readFile(path.join(root, "objects", parsed.key));
    if (bytes.length < 2)
      throw new Error("Transport controls require a nonempty archive");
    response.writeHead(200, {
      "content-type": "application/octet-stream",
      "content-length": bytes.length,
      connection: "close",
    });
    if (match[1] === "truncated") {
      response.end(bytes.subarray(0, Math.floor(bytes.length / 2)));
      console.log(
        JSON.stringify({
          mode: "truncated",
          key,
          advertisedBytes: bytes.length,
          sentBytes: Math.floor(bytes.length / 2),
        }),
      );
      return;
    }
    let offset = 0;
    const chunkSize = Math.ceil(bytes.length / 16);
    const sendChunk = () => {
      const end = Math.min(offset + chunkSize, bytes.length);
      response.write(bytes.subarray(offset, end));
      offset = end;
      if (offset === bytes.length) response.end();
    };
    const timer = setInterval(sendChunk, 400);
    response.once("close", () => {
      clearInterval(timer);
      console.log(
        JSON.stringify({
          mode: "slow",
          key,
          advertisedBytes: bytes.length,
          sentBytes: offset,
          completed: offset === bytes.length,
        }),
      );
    });
    sendChunk();
  } catch (error) {
    console.error(error.message);
    response.writeHead(error.code === "ENOENT" ? 404 : 400).end();
  }
});
server.listen(port, "127.0.0.1", async () => {
  await fs.writeFile(path.join(root, "network-qa.pid"), `${process.pid}\n`);
  console.log(
    JSON.stringify({ status: "listening", origin, pid: process.pid }),
  );
});
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () =>
    server.close(async () => {
      await fs.rm(path.join(root, "network-qa.pid"), { force: true });
      process.exit(0);
    }),
  );
}
