export const mockScenario = `
import { mockStorage } from "@hot-updater/mock/storage";
import { createNodeStorageContext } from "@hot-updater/plugin-core/storage/node";
const storage = mockStorage();
const context = createNodeStorageContext({ environment: {} });
const bytes = new Uint8Array([11, 22, 33, 44]);
const put = await storage.put({ context, key: "manual/mock", body: bytes, contentLength: bytes.length });
const head = await storage.head({ context, storageUri: put.storageUri });
const get = await storage.get({ context, storageUri: put.storageUri, range: { start: 1, end: 2 } });
const observed = get.kind === "found" ? [...new Uint8Array(await new Response(get.body).arrayBuffer())] : [];
const deleted = await storage.delete({ context, storageUri: put.storageUri });
const cleanup = storage.onUnmount?.();
await cleanup;
if (put.kind !== "stored" || head.kind !== "found" || observed.join(",") !== "22,33" || deleted.kind !== "deleted") process.exit(2);
console.log(JSON.stringify({ uri: put.storageUri, bytes: observed, cleanup: true }));
`;

export const legacyConfig = `
export default {
  storage: () => ({
    name: "manualLegacy",
    supportedProtocol: "legacy",
    profiles: {
      node: {
        async upload() { return { storageUri: "legacy://manual/item" }; },
        async delete() {},
        async downloadBundle() {},
        async exists() { return true; },
      },
      runtime: {
        async readText() { return "legacy-packed"; },
        async getDownloadUrl() { return { fileUrl: "https://legacy.invalid/item" }; },
      },
    },
    onUnmount() { Reflect.set(process, "__manualLegacyClosed", true); },
  }),
};
`;

export const legacyScenario = `
import { loadConfig } from "@hot-updater/cli-tools";
const config = await loadConfig(null);
const storage = await config.storage();
const text = await storage.profiles.runtime.readText("legacy://manual/item");
await config.disposeStorage();
if (text !== "legacy-packed" || Reflect.get(process, "__manualLegacyClosed") !== true) process.exit(2);
console.log(JSON.stringify({ text, legacyCalls: 1, cleanup: true }));
`;

export const workerScenario = `
import { binding } from "@hot-updater/core/config";
import { r2Storage, createWorkerStorageContext } from "@hot-updater/cloudflare/storage/worker";
const makeBucket = (id) => ({
  id, calls: [], objects: new Map(),
  async put(key, value) { this.calls.push(id + ":" + key); const bytes = value instanceof Uint8Array ? value : new Uint8Array(await new Response(value).arrayBuffer()); this.objects.set(key, bytes); return { key, size: bytes.length, etag: id, uploaded: new Date(0) }; },
  async head(key) { const bytes = this.objects.get(key); return bytes ? { key, size: bytes.length, etag: id, uploaded: new Date(0) } : null; },
  async get() { return null; },
  async delete(key) { this.objects.delete(key); },
});
const a = makeBucket("A");
const b = makeBucket("B");
const storage = r2Storage({ bucket: binding("BUCKET"), bucketName: "manual" });
const contexts = [
  createWorkerStorageContext({ environment: { REQUEST: "A1" }, bindings: { BUCKET: a } }),
  createWorkerStorageContext({ environment: { REQUEST: "B" }, bindings: { BUCKET: b } }),
  createWorkerStorageContext({ environment: { REQUEST: "A2" }, bindings: { BUCKET: a } }),
];
await Promise.all(contexts.map((context, index) => storage.put({ context, key: "item-" + index, body: new Uint8Array([index]), contentLength: 1 })));
if (a.calls.join(",") !== "A:item-0,A:item-2" || b.calls.join(",") !== "B:item-1") process.exit(2);
console.log(JSON.stringify({ contextIds: contexts.map((value) => value.environment.REQUEST), bindingIdentity: true, calls: [...a.calls, ...b.calls] }));
`;

export const standaloneScenario = `
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { standaloneStorage as legacyStorage } from "@hot-updater/standalone";
import { createStandaloneStorageHandler, standaloneStorage } from "@hot-updater/standalone/storage";
import { createStoragePlugin } from "@hot-updater/plugin-core/storage";
import { createNodeStorageContext } from "@hot-updater/plugin-core/storage/node";
const objects = new Map();
const remote = createStoragePlugin({ name: "manualRemote", protocol: "http", plugin: () => ({
  async put(input) { const uri = "http://manual/" + input.key; const bytes = input.body instanceof Uint8Array ? input.body : new Uint8Array(await new Response(input.body).arrayBuffer()); objects.set(uri, bytes); return { kind: "stored", storageUri: uri }; },
  async head(input) { const bytes = objects.get(input.storageUri); return bytes ? { kind: "found", storageUri: input.storageUri, metadata: { contentLength: bytes.length } } : { kind: "not-found" }; },
  async get(input) { const bytes = objects.get(input.storageUri); return bytes ? { kind: "found", storageUri: input.storageUri, metadata: { contentLength: bytes.length }, body: new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } }) } : { kind: "not-found" }; },
  async delete(input) { return objects.delete(input.storageUri) ? { kind: "deleted" } : { kind: "not-found" }; },
}) });
const context = createNodeStorageContext({ environment: {} });
const handler = createStandaloneStorageHandler({ storage: remote, context, authorize: () => true });
const server = createServer(async (incoming, outgoing) => {
  if (incoming.url === "/readText") { incoming.resume(); outgoing.end("legacy-route"); return; }
  const method = incoming.method ?? "GET";
  const body = method === "GET" || method === "HEAD" ? undefined : Readable.toWeb(incoming);
  const request = new Request("http://127.0.0.1" + incoming.url, { method, headers: incoming.headers, ...(body === undefined ? {} : { body, duplex: "half" }) });
  const response = await handler(request);
  if (!response) { outgoing.writeHead(404).end(); return; }
  outgoing.writeHead(response.status, Object.fromEntries(response.headers));
  response.body ? Readable.fromWeb(response.body).pipe(outgoing) : outgoing.end();
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
const baseUrl = "http://127.0.0.1:" + address.port;
const storage = standaloneStorage({ baseUrl });
const put = await storage.put({ context, key: "stream", body: new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([7,8])); controller.enqueue(new Uint8Array([9])); controller.close(); } }), contentLength: 3 });
const get = await storage.get({ context, storageUri: put.storageUri });
const bytes = get.kind === "found" ? [...new Uint8Array(await new Response(get.body).arrayBuffer())] : [];
const legacy = legacyStorage({ baseUrl })();
const text = await legacy.profiles.runtime.readText("http://manual/stream");
await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
if (bytes.join(",") !== "7,8,9" || text !== "legacy-route") process.exit(2);
console.log(JSON.stringify({ uri: put.storageUri, bytes, legacyRoute: text, openHandles: false }));
`;
