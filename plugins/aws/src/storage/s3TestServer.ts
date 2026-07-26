import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";

type StoredObject = Readonly<{
  body: Uint8Array;
  contentType?: string;
  metadata: Readonly<Record<string, string>>;
  etag: string;
  lastModified: string;
}>;

type RecordedRequest = Readonly<{
  method: string;
  path: string;
  authorization?: string;
}>;

const readRequest = async (request: IncomingMessage): Promise<Uint8Array> => {
  const chunks: Uint8Array[] = [];
  for await (const chunk of request) {
    if (typeof chunk === "string") {
      chunks.push(new TextEncoder().encode(chunk));
    } else {
      chunks.push(new Uint8Array(chunk));
    }
  }
  const length = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
};

const objectKey = (request: IncomingMessage): string =>
  new URL(request.url ?? "/", "http://s3.test").pathname
    .split("/")
    .slice(2)
    .join("/");

const metadataFromHeaders = (
  headers: IncomingMessage["headers"],
): Readonly<Record<string, string>> =>
  Object.fromEntries(
    Object.entries(headers)
      .filter(
        (entry): entry is [string, string] =>
          entry[0].startsWith("x-amz-meta-") && typeof entry[1] === "string",
      )
      .map(([name, value]) => [name.slice("x-amz-meta-".length), value]),
  );

export type S3TestServer = Readonly<{
  cancelledStreams: string[];
  endpoint: string;
  objects: Map<string, StoredObject>;
  requests: RecordedRequest[];
  close: () => Promise<void>;
}>;

export const startS3TestServer = async (): Promise<S3TestServer> => {
  const activeStreamResponses = new Set<ServerResponse>();
  const cancelledStreams: string[] = [];
  const objects = new Map<string, StoredObject>();
  const requests: RecordedRequest[] = [];
  const server: Server = createServer(async (request, response) => {
    const method = request.method ?? "GET";
    const path = request.url ?? "/";
    requests.push({
      method,
      path,
      ...(request.headers.authorization === undefined
        ? {}
        : { authorization: request.headers.authorization }),
    });
    const key = objectKey(request);
    const forcedStatus = /^errors\/(\d{3})$/.exec(key);
    if (forcedStatus !== null) {
      response.statusCode = Number(forcedStatus[1]);
      response.end();
      return;
    }
    const stored = objects.get(key);

    if (method === "PUT") {
      if (request.headers["if-none-match"] === "*" && stored !== undefined) {
        response.statusCode = 412;
        response.end();
        return;
      }
      const body = await readRequest(request);
      objects.set(key, {
        body,
        ...(request.headers["content-type"] === undefined
          ? {}
          : { contentType: request.headers["content-type"] }),
        metadata: metadataFromHeaders(request.headers),
        etag: `"etag-${key}"`,
        lastModified: new Date(0).toUTCString(),
      });
      response.statusCode = 200;
      response.setHeader("etag", `"etag-${key}"`);
      response.end();
      return;
    }

    if (stored === undefined) {
      response.statusCode = 404;
      response.end();
      return;
    }

    if (method === "DELETE") {
      objects.delete(key);
      response.statusCode = 204;
      response.end();
      return;
    }

    response.setHeader("etag", stored.etag);
    response.setHeader("last-modified", stored.lastModified);
    if (stored.contentType !== undefined) {
      response.setHeader("content-type", stored.contentType);
    }
    for (const [name, value] of Object.entries(stored.metadata)) {
      response.setHeader(`x-amz-meta-${name}`, value);
    }

    if (method === "HEAD") {
      response.setHeader("content-length", stored.body.byteLength);
      response.statusCode = 200;
      response.end();
      return;
    }

    if (key.startsWith("abort-stream/")) {
      activeStreamResponses.add(response);
      response.setHeader("content-length", stored.body.byteLength);
      response.statusCode = 200;
      response.once("close", () => {
        activeStreamResponses.delete(response);
        if (!response.writableEnded) {
          cancelledStreams.push(key);
        }
      });
      response.flushHeaders();
      if (key.endsWith("/during-read")) {
        response.write(stored.body.slice(0, 1));
      }
      return;
    }

    const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range ?? "");
    if (range !== null) {
      const start = Number(range[1]);
      const end =
        range[2] === "" ? stored.body.byteLength - 1 : Number(range[2]);
      const body = stored.body.slice(start, end + 1);
      response.statusCode = 206;
      response.setHeader(
        "content-range",
        `bytes ${start}-${end}/${stored.body.byteLength}`,
      );
      response.setHeader("content-length", body.byteLength);
      response.end(body);
      return;
    }

    response.statusCode = 200;
    response.setHeader("content-length", stored.body.byteLength);
    response.end(stored.body);
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new TypeError("S3 test server did not bind a TCP port.");
  }
  return {
    cancelledStreams,
    endpoint: `http://127.0.0.1:${address.port}`,
    objects,
    requests,
    close: () => {
      for (const response of activeStreamResponses) {
        response.destroy();
      }
      return new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error === undefined) {
            resolve();
            return;
          }
          reject(error);
        });
      });
    },
  };
};
