import { readFile } from "node:fs/promises";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  stageFunctionDeployment,
  VERCEL_FUNCTION_CONFIG,
  verifyFunction,
} from "./vercelFunction";

describe("stageFunctionDeployment", () => {
  it("stages the Function and the rewrite that serves every path with it", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "vercel-fn-"));
    try {
      const bundle = path.join(directory, "index.mjs");
      await writeFile(bundle, "export const GET = () => new Response();");

      const staged = await stageFunctionDeployment(bundle);

      expect(
        await readFile(path.join(staged.root, "api/index.mjs"), "utf8"),
      ).toContain("export const GET");
      expect(
        JSON.parse(
          await readFile(path.join(staged.root, "vercel.json"), "utf8"),
        ),
      ).toEqual(VERCEL_FUNCTION_CONFIG);
      expect(VERCEL_FUNCTION_CONFIG.rewrites).toEqual([
        { source: "/(.*)", destination: "/api" },
      ]);
      await staged.remove();
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});

describe("verifyFunction", () => {
  it("accepts a production domain that answers /version", async () => {
    const fetchImpl = vi.fn(async () => Response.json({ version: "1.0.1" }));

    await verifyFunction("https://hot-updater.vercel.app", fetchImpl);

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://hot-updater.vercel.app/version",
      { redirect: "manual" },
    );
  });

  it("names Deployment Protection when production asks devices to sign in", async () => {
    for (const response of [
      new Response("Unauthorized", { status: 401 }),
      new Response(null, {
        headers: { location: "https://vercel.com/sso-api?url=x" },
        status: 302,
      }),
    ]) {
      await expect(
        verifyFunction("https://hot-updater.vercel.app", async () => response),
      ).rejects.toThrow("Deployment Protection");
    }
  });
});
