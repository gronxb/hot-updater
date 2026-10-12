import fs from "fs/promises";
import { createRequire } from "module";
import os from "os";
import path from "path";

import { InitError } from "@hot-updater/cli-tools";
import { execa } from "execa";

/** The project's `vercel.json`: every path goes to the one Function. */
export const VERCEL_FUNCTION_CONFIG = {
  $schema: "https://openapi.vercel.sh/vercel.json",
  functions: { "api/index.mjs": { maxDuration: 60 } },
  rewrites: [{ source: "/(.*)", destination: "/api" }],
} as const;

/**
 * The prebuilt Function this package ships, bundled with every dependency,
 * from the copy of @hot-updater/vercel the project installed.
 */
export const resolveFunctionBundle = (cwd: string) =>
  path.join(
    path.dirname(
      createRequire(path.join(cwd, "package.json")).resolve(
        "@hot-updater/vercel/package.json",
      ),
    ),
    "dist",
    "function",
    "index.mjs",
  );

/** A deployment directory with the Function and its `vercel.json`. */
export const stageFunctionDeployment = async (functionBundle: string) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hot-updater-vercel-"));
  await fs.mkdir(path.join(root, "api"));
  await fs.copyFile(functionBundle, path.join(root, "api", "index.mjs"));
  await fs.writeFile(
    path.join(root, "vercel.json"),
    `${JSON.stringify(VERCEL_FUNCTION_CONFIG, null, 2)}\n`,
  );
  return {
    root,
    remove: () => fs.rm(root, { force: true, recursive: true }),
  };
};

/**
 * Deploys the Function to the project's production with the Vercel CLI,
 * linked by VERCEL_ORG_ID and VERCEL_PROJECT_ID rather than a `.vercel`
 * directory.
 */
export const deployFunction = async ({
  cwd,
  projectId,
  teamId,
  token,
}: {
  readonly cwd: string;
  readonly projectId: string;
  readonly teamId: string;
  readonly token: string;
}) => {
  const staged = await stageFunctionDeployment(resolveFunctionBundle(cwd));
  try {
    await execa(
      "npx",
      ["vercel", "deploy", staged.root, "--prod", "--yes", "--scope", teamId],
      {
        cwd,
        env: {
          VERCEL_ORG_ID: teamId,
          VERCEL_PROJECT_ID: projectId,
          VERCEL_TOKEN: token,
        },
        extendEnv: true,
        stdio: "inherit",
      },
    );
  } finally {
    await staged.remove();
  }
};

const protectedMessage = (url: string, status: number) =>
  `${url} answered ${status}: Vercel Deployment Protection covers the production domain, which devices cannot pass. Allow public access to production in the project's Settings > Deployment Protection, then rerun init.`;

/**
 * Checks the deployed Function answers `/version` without Vercel's
 * Deployment Protection in front of it, which devices cannot pass.
 */
export const verifyFunction = async (
  baseUrl: string,
  fetchImpl: typeof fetch = fetch,
) => {
  const url = `${baseUrl}/version`;
  let lastStatus: number | undefined;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const response = await fetchImpl(url, { redirect: "manual" });
    lastStatus = response.status;
    if (response.ok) return;
    // Deployment Protection answers 401 or redirects to Vercel's login.
    if (response.status === 401 || response.status === 403) {
      throw new InitError(protectedMessage(url, response.status));
    }
    if (
      response.status >= 300 &&
      response.status < 400 &&
      (response.headers.get("location") ?? "").startsWith("https://vercel.com/")
    ) {
      throw new InitError(protectedMessage(url, response.status));
    }
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
  throw new InitError(
    `${url} answered ${lastStatus}. Check the Function's logs in the Vercel dashboard, then rerun init.`,
  );
};
