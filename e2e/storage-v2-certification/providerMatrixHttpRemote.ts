import { createStoragePlugin } from "../../plugins/plugin-core/src/storage";

export const createProviderMatrixHttpRemote = (origin: "A" | "B") => {
  const objects = new Map<string, Uint8Array>();
  return createStoragePlugin({
    name: "providerMatrixHttpRemote",
    protocol: "http",
    plugin: () => ({
      async put(input) {
        const storageUri = `http://remote.invalid/${origin}/${input.key}`;
        if (input.condition === "create-only" && objects.has(storageUri)) {
          return { kind: "already-exists", storageUri };
        }
        const body =
          input.body instanceof Uint8Array
            ? input.body
            : new Uint8Array(await new Response(input.body).arrayBuffer());
        objects.set(storageUri, body);
        return { kind: "stored", storageUri };
      },
      async head(input) {
        const body = objects.get(input.storageUri);
        return body === undefined
          ? { kind: "not-found" }
          : {
              kind: "found",
              storageUri: input.storageUri,
              metadata: { contentLength: body.byteLength },
            };
      },
      async get(input) {
        const body = objects.get(input.storageUri);
        if (body === undefined) return { kind: "not-found" };
        const start = input.range?.start ?? 0;
        const end = input.range?.end ?? body.byteLength - 1;
        return {
          kind: "found",
          storageUri: input.storageUri,
          body: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(body.slice(start, end + 1));
              controller.close();
            },
          }),
          metadata: { contentLength: body.byteLength },
          ...(input.range === undefined
            ? {}
            : {
                range: {
                  start,
                  end,
                  totalLength: body.byteLength,
                },
              }),
        };
      },
      async delete(input) {
        return objects.delete(input.storageUri)
          ? { kind: "deleted" }
          : { kind: "not-found" };
      },
      onUnmount() {
        objects.clear();
      },
    }),
  });
};
