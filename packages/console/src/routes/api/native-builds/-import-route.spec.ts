// @vitest-environment node

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { brotliDecompressSync } from "node:zlib";

import {
  createMemoryAdapter,
  createStorageAdapter,
  createStorageUri,
  parseStorageUri,
} from "@hot-updater/plugin-core";
import { createHotUpdater } from "@hot-updater/server";
import JSZip from "jszip";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { prepareConfigMock } = vi.hoisted(() => ({
  prepareConfigMock: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: unknown) => ({ options }),
}));
vi.mock("@/lib/server/config.server", () => ({
  prepareConfig: prepareConfigMock,
}));

import { Route } from "./import";

type ImportHandler = (input: {
  readonly request: Request;
}) => Promise<Response>;

const handler = (
  Route as unknown as {
    readonly options: {
      readonly server: { readonly handlers: { readonly POST: ImportHandler } };
    };
  }
).options.server.handlers.POST;

// Built by __fixtures__/generate.sh in @hot-updater/protocol with javac, d8,
// aapt2, clang and plutil; these are the values it compiled in.
const FIXTURES = path.resolve(
  import.meta.dirname,
  "../../../../../protocol/src/nativeArtifact/__fixtures__",
);
const fixture = (name: string) => readFileSync(path.join(FIXTURES, name));
const MIN_BUNDLE_ID = "019a2b3c-4d5e-7000-8000-000000000000";
const FINGERPRINT =
  "5de1cdbfefdc1f0b4a1b3c36ed83c246dff317dd540c0393ca76fa758026ec8f";
const BUILT_IN = Buffer.from("console.log('built-in');\n".repeat(32));

const sha256 = (bytes: Uint8Array | string) =>
  createHash("sha256").update(bytes).digest("hex");

const aab = async (overrides: Record<string, Uint8Array | null> = {}) => {
  const files: Record<string, Uint8Array | null> = {
    "base/manifest/AndroidManifest.xml": fixture("release.pb"),
    "base/dex/classes.dex": fixture("classes.dex"),
    "base/assets/index.android.bundle": BUILT_IN,
    ...overrides,
  };
  const archive = new JSZip();
  for (const [name, content] of Object.entries(files)) {
    if (content !== null) archive.file(name, content);
  }
  return archive.generateAsync({ type: "uint8array" });
};

/** Storage that keeps every object it is given, by key. */
const memoryStorage = () => {
  const objects = new Map<string, Uint8Array>();
  const keyOf = (storageUri: string) => parseStorageUri(storageUri, "mem").key;
  return {
    objects,
    adapter: createStorageAdapter({
      name: "memoryStorage",
      protocol: "mem",
      async put({ key, body }) {
        objects.set(
          key,
          new Uint8Array(await new Response(body).arrayBuffer()),
        );
        return {
          storageUri: createStorageUri({ protocol: "mem", bucket: "b", key }),
        };
      },
      async exists({ storageUri }) {
        return { exists: objects.has(keyOf(storageUri)) };
      },
      async delete({ storageUri }) {
        objects.delete(keyOf(storageUri));
        return { deleted: true };
      },
    }),
  };
};

const URL_BASE = "https://console.example.com/api/native-builds/import";

const post = (
  bytes: Uint8Array,
  {
    name = "app-release.aab",
    headers = { "sec-fetch-site": "same-origin" },
  }: { name?: string; headers?: Record<string, string> } = {},
) =>
  handler({
    request: new Request(`${URL_BASE}?name=${encodeURIComponent(name)}`, {
      method: "POST",
      body: bytes.slice(),
      headers: { "content-length": String(bytes.byteLength), ...headers },
    }),
  });

let core: ReturnType<typeof createHotUpdater>["core"];
let storage: ReturnType<typeof memoryStorage>;

const useConsole = (updateStrategy?: "fingerprint" | "appVersion") =>
  prepareConfigMock.mockResolvedValue({
    core,
    storage: storage.adapter,
    config: updateStrategy === undefined ? {} : { updateStrategy },
  });

beforeEach(() => {
  vi.clearAllMocks();
  storage = memoryStorage();
  ({ core } = createHotUpdater({
    database: { name: "memory", adapter: createMemoryAdapter() },
    storage: storage.adapter,
    clientAccess: "public",
  }));
  useConsole();
});

describe("native build import route", () => {
  it("stores an .aab and its built-in bundle and registers it, as the CLI does", async () => {
    const bytes = await aab();
    const response = await post(bytes);

    expect(response.status).toBe(201);
    const { nativeBuild } = (await response.json()) as {
      nativeBuild: { id: string };
    };
    // An empty registry and a fingerprint in the code: the fingerprint
    // strategy.
    const registered = await core.findNativeBuild({
      platform: "android",
      channel: "beta",
      fingerprintHash: FINGERPRINT,
      appVersion: null,
    });
    expect(registered).toMatchObject({
      id: nativeBuild.id,
      min_bundle_id: MIN_BUNDLE_ID,
      artifact_kind: "aab",
      byte_size: bytes.byteLength,
      build_key: null,
      git_commit_hash: null,
    });
    expect(
      Buffer.compare(
        storage.objects.get(
          `native-builds/android/${nativeBuild.id}/app-release.aab`,
        )!,
        bytes,
      ),
    ).toBe(0);
    const manifestBytes = storage.objects.get(
      `bundles/${MIN_BUNDLE_ID}/manifest.json`,
    )!;
    const manifest = JSON.parse(new TextDecoder().decode(manifestBytes));
    const asset = manifest.assets["index.android.bundle"];
    expect(asset).toMatchObject({
      byteSize: BUILT_IN.byteLength,
      fileHash: sha256(BUILT_IN),
    });
    expect(
      Buffer.compare(
        brotliDecompressSync(
          storage.objects.get(
            `assets/sha256/${asset.downloadFileHash.slice(0, 2)}/${asset.downloadFileHash}.br`,
          )!,
        ),
        BUILT_IN,
      ),
    ).toBe(0);
    await expect(core.getBundle(MIN_BUNDLE_ID)).resolves.toMatchObject({
      bundle: {
        manifest_storage_uri: `mem://b/bundles/${MIN_BUNDLE_ID}/manifest.json`,
        manifest_file_hash: sha256(manifestBytes),
        asset_base_storage_uri: "mem://b/assets",
      },
    });
  });

  it("registers by the configured update strategy", async () => {
    useConsole("appVersion");
    const response = await post(await aab());

    expect(response.status).toBe(201);
    await expect(
      core.findNativeBuild({
        platform: "android",
        channel: "beta",
        fingerprintHash: null,
        appVersion: "1.4.0",
      }),
    ).resolves.toMatchObject({ min_bundle_id: MIN_BUNDLE_ID });
  });

  it("refuses a build already registered, naming it, and keeps one artifact", async () => {
    const first = (await (await post(await aab())).json()) as {
      nativeBuild: { id: string };
    };
    const response = await post(await aab());

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      problems: [
        {
          code: "ALREADY_IMPORTED",
          nativeBuildId: first.nativeBuild.id,
          message: expect.stringContaining(
            `native build ${first.nativeBuild.id}`,
          ),
        },
      ],
    });
    expect(
      [...storage.objects.keys()].filter((key) =>
        key.startsWith("native-builds/"),
      ),
    ).toHaveLength(1);
  });

  it("refuses what the CLI refuses, reading the uploaded file, and stores nothing", async () => {
    const response = await post(
      await aab({
        "base/dex/classes.dex": fixture("plain.dex"),
        "base/assets/index.android.bundle": null,
      }),
    );

    expect(response.status).toBe(422);
    const { problems } = (await response.json()) as {
      problems: { code: string }[];
    };
    expect(problems.map(({ code }) => code)).toEqual([
      "NO_BUILT_IN_BUNDLE",
      "NO_MIN_BUNDLE_ID",
    ]);
    expect(storage.objects.size).toBe(0);
  });

  it("refuses a file that is no store artifact", async () => {
    const response = await post(await aab(), { name: "app.zip" });

    expect(response.status).toBe(415);
    expect(storage.objects.size).toBe(0);
  });

  it("refuses another site's request before it reads the session", async () => {
    for (const headers of [
      { "sec-fetch-site": "cross-site" } as Record<string, string>,
      { origin: "https://evil.example.com" },
      {},
    ]) {
      const response = await post(await aab(), { headers });
      expect(response.status).toBe(403);
    }
    expect(prepareConfigMock).not.toHaveBeenCalled();
    // Without fetch metadata, the console's own origin passes.
    const own = await post(await aab(), {
      headers: { origin: "https://console.example.com" },
    });
    expect(own.status).toBe(201);
  });

  it("answers a caller without a session with the console's own answer", async () => {
    prepareConfigMock.mockRejectedValueOnce(
      new Response("Unauthorized", { status: 401 }),
    );
    const response = await post(await aab());

    expect(response.status).toBe(401);
    expect(storage.objects.size).toBe(0);
  });
});
