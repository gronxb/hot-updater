import {
  type ArtifactInfo,
  encodeChannelKey,
  type ReleaseCatalog,
} from "@hot-updater/protocol";
import { setupStorageAdapterTestSuite } from "@hot-updater/test-utils";
import { afterAll, describe, expect, it } from "vitest";

import { GITHUB_UPDATE_BASE_URL, githubUpdateFetch } from "./client";
import { deployFixtureBundle, FIXTURE_BUNDLE_BYTES } from "./github.fixture";
import { createGithubClient, encodePath } from "./githubApi";
import { createGithubJsonStore } from "./githubJsonStore";
import { githubReleaseStorage } from "./githubReleaseStorage";

/**
 * Runs against a real repository, which the adapters' unit specs replace
 * with a fake:
 *
 *   HOT_UPDATER_INTEGRATION_GROUP=rest \
 *   HOT_UPDATER_GITHUB_TEST_REPOSITORY=owner/repo \
 *   HOT_UPDATER_GITHUB_TEST_TOKEN=github_pat_... \
 *   pnpm vitest run --project integration:default plugins/github
 *
 * The `rest` group avoids unrelated integration-project global setup.
 *
 * The token needs read and write access to the repository's contents. The
 * repository must have a commit, and may be private. Everything is written
 * below `hot-updater-test/<run>` and deleted afterwards, releases included.
 */
const repository = process.env.HOT_UPDATER_GITHUB_TEST_REPOSITORY;
const token = process.env.HOT_UPDATER_GITHUB_TEST_TOKEN;

if (!repository || !token) {
  describe.skip("GitHub (needs HOT_UPDATER_GITHUB_TEST_REPOSITORY and HOT_UPDATER_GITHUB_TEST_TOKEN)", () => {
    it("runs against a real repository", () => {});
  });
} else {
  const [owner, repo] = repository.split("/") as [string, string];
  const github = { owner, repo, token };
  const client = createGithubClient(github);
  const run = `hot-updater-test/${crypto.randomUUID().slice(0, 8)}`;
  const indexPath = `${run}/storage.json`;
  const path = `${run}/database.json`;
  const NIL_UUID = "00000000-0000-0000-0000-000000000000";

  const readFile = async (file: string) => {
    const response = await client.request(
      client.repoUrl(`/contents/${encodePath(file)}`),
    );
    return response.ok
      ? ((await response.json()) as { sha: string; content: string })
      : null;
  };

  afterAll(async () => {
    // The index names every release the run created.
    const index = await readFile(indexPath);
    if (index !== null) {
      const { data } = JSON.parse(
        Buffer.from(index.content, "base64").toString("utf8"),
      ) as { data: { releases: Record<string, number> } };
      for (const id of Object.keys(data.releases)) {
        const release = await client.request(client.repoUrl(`/releases/${id}`));
        const { tag_name: tag } = (await release.json()) as {
          tag_name: string;
        };
        await client.request(client.repoUrl(`/releases/${id}`), {
          method: "DELETE",
        });
        await client.request(
          client.repoUrl(`/git/refs/tags/${encodeURIComponent(tag)}`),
          { method: "DELETE" },
        );
      }
    }
    for (const file of [indexPath, path]) {
      const current = await readFile(file);
      if (current === null) continue;
      await client.request(client.repoUrl(`/contents/${encodePath(file)}`), {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          message: `test: remove ${file}`,
          sha: current.sha,
        }),
      });
    }
  }, 300_000);

  setupStorageAdapterTestSuite({
    name: "githubReleaseStorage (GitHub)",
    createStorage: async () => {
      const basePath = `conformance/${crypto.randomUUID()}`;
      const storage = githubReleaseStorage({ ...github, basePath, indexPath });
      return {
        storage,
        basePath,
        cleanup: async () => {
          const objects = await storage.listObjects();
          await storage.deleteObjects(objects.map(({ key }) => key));
        },
      };
    },
    operations: [
      "put",
      "get",
      "getDownloadUrl",
      "exists",
      "delete",
      "listObjects",
      "deleteObjects",
    ],
    fetchDownloadUrls: true,
  });

  describe("githubJsonDatabase (GitHub)", () => {
    it("lets one of two processes take a contested key, and loses neither's writes", async () => {
      const options = { ...github, path: `${run}/contended.json` };
      const first = createGithubJsonStore(options);
      const second = createGithubJsonStore(options);
      const put = (id: string) => ({
        type: "put" as const,
        key: { pk: "items", sk: id },
        value: { id },
        condition: { exists: false },
      });
      try {
        const results = await Promise.all([
          first.write([put("contested")]),
          second.write([put("contested")]),
          first.write([put("a")]),
          second.write([put("b")]),
        ]);

        expect(results.map((result) => result.ok).sort()).toEqual([
          false,
          true,
          true,
          true,
        ]);
        expect(
          await first.get(
            ["contested", "a", "b"].map((sk) => ({ pk: "items", sk })),
          ),
        ).toEqual([{ id: "contested" }, { id: "a" }, { id: "b" }]);
      } finally {
        const current = await readFile(options.path);
        if (current !== null) {
          await client.request(
            client.repoUrl(`/contents/${encodePath(options.path)}`),
            {
              method: "DELETE",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                message: "test: remove contended.json",
                sha: current.sha,
              }),
            },
          );
        }
      }
    });
  });

  describe("an app without an update server (GitHub)", () => {
    it("checks for an update and downloads it with only the repository and a token", async () => {
      const basePath = `${run}/app`;
      const { bundle, manifest, storage } = await deployFixtureBundle({
        ...github,
        path,
        indexPath,
        basePath,
      });
      const appFetch = githubUpdateFetch({
        ...github,
        databasePath: path,
        storageIndexPath: indexPath,
        basePath,
      });
      try {
        const check = await appFetch(
          `${GITHUB_UPDATE_BASE_URL}/release-catalogs/app-version/ios/${encodeChannelKey("production")}/1.2.3`,
        );
        expect(check.status).toBe(200);
        const catalog = (await check.json()) as ReleaseCatalog;
        expect(JSON.stringify(catalog.releases)).toContain(bundle.id);

        const artifact = await appFetch(
          `${GITHUB_UPDATE_BASE_URL}/artifacts/v1/${bundle.id}/from/${NIL_UUID}`,
        );
        expect(artifact.status).toBe(200);
        const info = (await artifact.json()) as ArtifactInfo;
        // As native downloads: no headers, only the URL.
        const download = async (url: string) => {
          const file = await fetch(url);
          expect(file.status).toBe(200);
          return new Uint8Array(await file.arrayBuffer());
        };
        expect(new TextDecoder().decode(await download(info.manifestUrl))).toBe(
          manifest,
        );
        expect(
          await download(info.assets["index.ios.bundle"]!.file.url),
        ).toEqual(FIXTURE_BUNDLE_BYTES);
      } finally {
        const objects = await storage.listObjects();
        await storage.deleteObjects(objects.map(({ key }) => key));
      }
    });
  });
}
