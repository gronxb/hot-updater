type StoredObject = Readonly<{
  bytes: Uint8Array;
  contentType: string;
  metadata: Readonly<Record<string, string>>;
}>;

type RecordedRequest = Readonly<{
  authorization: string | null;
  host: string;
  method: string;
  path: string;
}>;

const readBody = async (request: Request): Promise<Uint8Array> =>
  new Uint8Array(await request.arrayBuffer());

const parseMetadataHeader = (
  metadataHeader: string | null,
): Readonly<Record<string, string>> => {
  if (metadataHeader === null) {
    return {};
  }
  const value: unknown = JSON.parse(atob(metadataHeader));
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
};

export class SupabaseStorageHttpFake {
  readonly objects = new Map<string, StoredObject>();
  readonly requests: RecordedRequest[] = [];
  outputCancelled = false;
  #failure: Readonly<{ status: number; body: unknown }> | undefined;
  #keepOutputOpen = false;
  #malformedInfo = false;
  #wrongRange = false;
  readonly #pendingUploads = new Set<string>();

  readonly fetch = async (
    input: Parameters<typeof fetch>[0],
    init?: RequestInit,
  ): Promise<Response> => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    this.requests.push({
      authorization: request.headers.get("authorization"),
      host: url.host,
      method: request.method,
      path: url.pathname,
    });
    if (this.#failure !== undefined) {
      const failure = this.#failure;
      this.#failure = undefined;
      return Response.json(failure.body, { status: failure.status });
    }

    const objectPrefix = "/storage/v1/object/";
    const infoPrefix = "/storage/v1/object/info/";
    const signPrefix = "/storage/v1/object/sign/";
    if (url.pathname.startsWith(infoPrefix)) {
      return this.#info(url.pathname.slice(infoPrefix.length));
    }
    if (url.pathname.startsWith(signPrefix)) {
      const key = url.pathname
        .slice(signPrefix.length)
        .split("/")
        .slice(1)
        .join("/");
      return Response.json({ signedURL: `/signed/${key}` });
    }
    if (url.pathname.startsWith(objectPrefix)) {
      const objectPath = url.pathname.slice(objectPrefix.length);
      if (request.method === "POST") {
        return this.#put(request, objectPath);
      }
      if (request.method === "GET") {
        return this.#get(request, objectPath);
      }
      if (request.method === "DELETE") {
        return this.#delete(request, objectPath);
      }
    }
    return Response.json({ message: "missing route" }, { status: 404 });
  };

  failNext(status: number, body: unknown): void {
    this.#failure = { status, body };
  }

  reset(): void {
    this.objects.clear();
    this.requests.length = 0;
    this.outputCancelled = false;
    this.#failure = undefined;
    this.#keepOutputOpen = false;
    this.#malformedInfo = false;
    this.#wrongRange = false;
    this.#pendingUploads.clear();
  }

  setKeepOutputOpen(value: boolean): void {
    this.#keepOutputOpen = value;
  }

  setMalformedInfo(value: boolean): void {
    this.#malformedInfo = value;
  }

  setWrongRange(value: boolean): void {
    this.#wrongRange = value;
  }

  async #put(request: Request, objectPath: string): Promise<Response> {
    if (
      request.headers.get("x-upsert") === "false" &&
      (this.objects.has(objectPath) || this.#pendingUploads.has(objectPath))
    ) {
      return Response.json({ message: "already exists" }, { status: 409 });
    }
    this.#pendingUploads.add(objectPath);
    const metadata = parseMetadataHeader(request.headers.get("x-metadata"));
    try {
      this.objects.set(objectPath, {
        bytes: await readBody(request),
        contentType:
          request.headers.get("content-type") ?? "application/octet-stream",
        metadata,
      });
    } finally {
      this.#pendingUploads.delete(objectPath);
    }
    return Response.json({ Key: objectPath });
  }

  #info(objectPath: string): Response {
    const stored = this.objects.get(objectPath);
    if (stored === undefined) {
      return Response.json({ message: "not found" }, { status: 404 });
    }
    if (this.#malformedInfo) {
      return Response.json({ size: "wrong" });
    }
    return Response.json({
      content_type: stored.contentType,
      etag: "etag",
      metadata: stored.metadata,
      size: stored.bytes.byteLength,
      updated_at: "2026-07-27T00:00:00.000Z",
    });
  }

  #get(request: Request, objectPath: string): Response {
    const stored = this.objects.get(objectPath);
    if (stored === undefined) {
      return Response.json({ message: "not found" }, { status: 404 });
    }
    const range = request.headers.get("range");
    const match = range?.match(/^bytes=(\d+)-(\d*)$/u);
    const start = match?.[1] === undefined ? 0 : Number(match[1]);
    const requestedEnd =
      match?.[2] === undefined || match[2] === ""
        ? stored.bytes.byteLength - 1
        : Number(match[2]);
    const end = Math.min(requestedEnd, stored.bytes.byteLength - 1);
    const bytes = stored.bytes.slice(start, end + 1);
    const keepOutputOpen = this.#keepOutputOpen;
    const body = new ReadableStream<Uint8Array>({
      cancel: () => {
        this.outputCancelled = true;
      },
      start(controller) {
        controller.enqueue(bytes);
        if (!keepOutputOpen) {
          controller.close();
        }
      },
    });
    const headers = new Headers({
      "content-length": String(bytes.byteLength),
      "content-type": stored.contentType,
    });
    if (range !== null) {
      headers.set(
        "content-range",
        this.#wrongRange
          ? `bytes 0-${end}/${stored.bytes.byteLength}`
          : `bytes ${start}-${end}/${stored.bytes.byteLength}`,
      );
    }
    return new Response(body, { headers, status: range === null ? 200 : 206 });
  }

  async #delete(request: Request, bucket: string): Promise<Response> {
    const body: unknown = await request.json();
    const prefixes =
      typeof body === "object" &&
      body !== null &&
      "prefixes" in body &&
      Array.isArray(body.prefixes)
        ? body.prefixes
        : [];
    const removed = prefixes.flatMap((prefix) => {
      if (typeof prefix !== "string") {
        return [];
      }
      const objectPath = `${bucket}/${prefix}`;
      if (!this.objects.delete(objectPath)) {
        return [];
      }
      return [{ name: prefix }];
    });
    return Response.json(removed);
  }
}
