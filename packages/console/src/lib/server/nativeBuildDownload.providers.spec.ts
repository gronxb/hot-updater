// @vitest-environment node

import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import { s3Storage } from "@hot-updater/aws";
import { azureBlobStorage } from "@hot-updater/azure";
import { r2Storage } from "@hot-updater/cloudflare";
import { r2Storage as r2BindingStorage } from "@hot-updater/cloudflare/worker";
import { firebaseStorage } from "@hot-updater/firebase";
import { neonStorage } from "@hot-updater/neon";
import type { NativeBuildRow, StorageAdapter } from "@hot-updater/plugin-core";
import { supabaseStorage } from "@hot-updater/supabase";
import { vercelBlobStorage } from "@hot-updater/vercel";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { downloadNativeBuild } from "./nativeBuilds";

/**
 * Every provider's real storage adapter behind the console's download: what
 * a token link answers with. An adapter that signs by itself signs here;
 * the ones that ask their service for the URL get that service's answer.
 * "GCS" is the Firebase adapter's `gs://`: there is no other GCS adapter.
 */
type R2BindingBucket = Parameters<typeof r2BindingStorage>[0]["bucket"];

const KEY = "native-builds/android/build-1/app-release.apk";
const FILE_NAME = "app-release.apk";

const R2_CREDENTIALS = {
  accessKeyId: "AKIAIOSFODNN7EXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
};
const AZURITE_KEY =
  "Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==";
const VERCEL_TOKEN = "vercel_blob_rw_abc123_secretpart";

const download = (storage: StorageAdapter, storageUri: string) =>
  downloadNativeBuild("build-1", {
    core: {
      getNativeBuild: async () =>
        ({
          artifact_kind: "apk",
          artifact_storage_uri: storageUri,
        }) as NativeBuildRow,
    },
    storage,
  });

const expectRedirect = (response: Response, host: RegExp) => {
  expect(response.status).toBe(302);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  const location = new URL(response.headers.get("location")!);
  expect(location.protocol).toBe("https:");
  expect(location.host).toMatch(host);
  // A browser names the download after the URL's last segment, and the
  // storage serves the type the upload stored: see storageFiles.spec.ts.
  expect(decodeURIComponent(location.pathname)).toContain(KEY);
  expect(location.pathname.split("/").at(-1)).toBe(FILE_NAME);
  return location;
};

describe("a native build's download on each storage", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("S3 redirects to a presigned URL", async () => {
    const response = await download(
      s3Storage({
        bucketName: "bundles",
        region: "us-east-1",
        credentials: R2_CREDENTIALS,
      }),
      `s3://bundles/${KEY}`,
    );

    const location = expectRedirect(response, /amazonaws\.com$/);
    expect(location.searchParams.get("X-Amz-Signature")).toBeTruthy();
  });

  it("R2 redirects to a presigned URL", async () => {
    const response = await download(
      r2Storage({
        bucketName: "bundles",
        accountId: "account",
        credentials: R2_CREDENTIALS,
      }),
      `r2://bundles/${KEY}`,
    );

    const location = expectRedirect(response, /r2\.cloudflarestorage\.com$/);
    expect(location.searchParams.get("X-Amz-Signature")).toBeTruthy();
  });

  it("R2 on a Worker's binding redirects with credentials", async () => {
    const response = await download(
      r2BindingStorage({
        bucket: {} as R2BindingBucket,
        bucketName: "bundles",
        accountId: "account",
        credentials: R2_CREDENTIALS,
      }),
      `r2://bundles/${KEY}`,
    );

    const location = expectRedirect(response, /r2\.cloudflarestorage\.com$/);
    expect(location.searchParams.get("X-Amz-Signature")).toBeTruthy();
  });

  it("R2 on a Worker's binding streams without credentials: it has no URL to give", async () => {
    const bytes = new TextEncoder().encode("apk bytes");
    const get = vi.fn(async () => ({
      body: new Blob([bytes]).stream(),
      httpEtag: '"etag"',
      size: bytes.byteLength,
      writeHttpMetadata: (headers: Headers) =>
        headers.set("content-type", "application/vnd.android.package-archive"),
    }));

    const storage = r2BindingStorage({
      bucket: { get } as unknown as R2BindingBucket,
      bucketName: "bundles",
    });
    const response = await download(storage, `r2://bundles/${KEY}`);

    expect(storage.getDownloadUrl).toBeUndefined();
    expect(response.status).toBe(200);
    expect(get).toHaveBeenCalledWith(KEY);
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("content-type")).toBe(
      "application/vnd.android.package-archive",
    );
    expect(response.headers.get("content-disposition")).toBe(
      `attachment; filename="${FILE_NAME}"; filename*=UTF-8''${FILE_NAME}`,
    );
    expect(response.headers.get("content-length")).toBe(
      String(bytes.byteLength),
    );
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
  });

  it("Neon redirects to a presigned URL", async () => {
    const response = await download(
      neonStorage({
        bucketName: "bundles",
        endpoint: "https://branch.storage.neon.tech",
        credentials: R2_CREDENTIALS,
      }),
      `neon://bundles/${KEY}`,
    );

    const location = expectRedirect(response, /neon\.tech$/);
    expect(location.searchParams.get("X-Amz-Signature")).toBeTruthy();
  });

  it("Azure redirects to a SAS URL", async () => {
    const response = await download(
      azureBlobStorage({
        connectionString: `DefaultEndpointsProtocol=https;AccountName=account;AccountKey=${AZURITE_KEY};EndpointSuffix=core.windows.net`,
        containerName: "bundles",
      }),
      `azblob://bundles/${KEY}`,
    );

    const location = expectRedirect(response, /blob\.core\.windows\.net$/);
    expect(location.searchParams.get("sig")).toBeTruthy();
  });

  it("Supabase redirects to the signed URL its Storage returns", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json([
        {
          path: KEY,
          signedURL: `/object/sign/bundles/${KEY}?token=signed`,
          error: null,
        },
      ]),
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await download(
      supabaseStorage({
        supabaseUrl: "https://project.supabase.co",
        supabaseServiceRoleKey: "service-role-key",
        bucketName: "bundles",
      } as Parameters<typeof supabaseStorage>[0]),
      `supabase-storage://bundles/${KEY}`,
    );

    const location = expectRedirect(response, /supabase\.co$/);
    expect(location.searchParams.get("token")).toBe("signed");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  describe("Vercel Blob", () => {
    let api: Server;

    // The Blob SDK asks Vercel's API for its one delegation over its own
    // fetch, and signs the URL by itself: the local API answers the first.
    beforeAll(async () => {
      const delegation = Buffer.from(
        JSON.stringify({
          storeId: "abc123",
          pathname: "*",
          operations: ["get"],
          validUntil: Date.now() + 7 * 24 * 60 * 60 * 1000,
        }),
      ).toString("base64url");
      api = createServer((_request, response) => {
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            delegationToken: `${delegation}.signature`,
            clientSigningToken: "client-signing-token",
            validUntil: Date.now() + 7 * 24 * 60 * 60 * 1000,
          }),
        );
      });
      await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
      vi.stubEnv(
        "VERCEL_BLOB_API_URL",
        `http://127.0.0.1:${(api.address() as AddressInfo).port}`,
      );
    });

    afterAll(async () => {
      vi.unstubAllEnvs();
      await new Promise((resolve) => api.close(resolve));
    });

    it("redirects to a presigned URL", async () => {
      const response = await download(
        vercelBlobStorage({ token: VERCEL_TOKEN }),
        `vercel-blob://store_abc123/${KEY}`,
      );

      const location = expectRedirect(response, /blob\.vercel-storage\.com$/);
      expect(location.search).toContain("signature");
    });
  });

  describe("Firebase (GCS)", () => {
    let directory: string;

    beforeAll(() => {
      const { privateKey } = generateKeyPairSync("rsa", {
        modulusLength: 2048,
        privateKeyEncoding: { format: "pem", type: "pkcs8" },
        publicKeyEncoding: { format: "pem", type: "spki" },
      });
      directory = mkdtempSync(path.join(tmpdir(), "hot-updater-firebase-"));
      const credentials = path.join(directory, "service-account.json");
      writeFileSync(
        credentials,
        JSON.stringify({
          type: "service_account",
          project_id: "project",
          client_email: "console@project.iam.gserviceaccount.com",
          private_key: privateKey,
        }),
      );
      vi.stubEnv("GOOGLE_APPLICATION_CREDENTIALS", credentials);
    });

    afterAll(() => {
      vi.unstubAllEnvs();
      rmSync(directory, { recursive: true, force: true });
    });

    it("redirects to a signed URL", async () => {
      const response = await download(
        firebaseStorage({ projectId: "project", storageBucket: "bundles" }),
        `gs://bundles/${KEY}`,
      );

      const location = expectRedirect(response, /storage\.googleapis\.com$/);
      expect(
        location.searchParams.get("X-Goog-Signature") ??
          location.searchParams.get("Signature"),
      ).toBeTruthy();
    });

    it("redirects to its CDN URL when it has one", async () => {
      const response = await download(
        firebaseStorage({
          projectId: "project",
          storageBucket: "bundles",
          cdnUrl: "https://cdn.example.com",
        }),
        `gs://bundles/${KEY}`,
      );

      expectRedirect(response, /^cdn\.example\.com$/);
    });
  });
});
