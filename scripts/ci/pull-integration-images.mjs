// @ts-check
/**
 * Pulls the Docker images of the integration group that
 * HOT_UPDATER_INTEGRATION_GROUP selects (its `docker` in
 * integration-groups.mjs), all at once, each up to three times, and prints
 * how long each took. Then, on GitHub Actions, it sets
 * HOT_UPDATER_DOCKER_PULL=never for the steps after it, so the group's specs
 * run Docker with `--pull never`: a pull never spends a hook's budget in
 * silence, and an image the group doesn't list fails by name.
 *
 *   HOT_UPDATER_INTEGRATION_GROUP=mongodb node scripts/ci/pull-integration-images.mjs
 */
import { execFile } from "node:child_process";
import { appendFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import {
  findIntegrationGroup,
  INTEGRATION_GROUP_ENV,
} from "./integration-groups.mjs";

const run = promisify(execFile);
const root = path.resolve(import.meta.dirname, "../..");
const ATTEMPTS = 3;
/** One attempt's limit. A cold pull of a group's images takes under a minute. */
const ATTEMPT_TIMEOUT_MS = 300_000;

const group = findIntegrationGroup(process.env[INTEGRATION_GROUP_ENV]);
if (!group) {
  throw new Error(`Set ${INTEGRATION_GROUP_ENV} to the group to pull for.`);
}

/** @type {{ name: string; args: string[] }[]} */
const pulls = [
  ...(group.docker?.compose ?? []).map((file) => ({
    name: file,
    args: ["compose", "-f", path.join(root, file), "pull", "--quiet"],
  })),
  ...(group.docker?.images ?? []).map((image) => ({
    name: image,
    args: ["pull", "--quiet", image],
  })),
];

const seconds = (/** @type {number} */ since) =>
  `${((performance.now() - since) / 1000).toFixed(1)}s`;

/** @param {{ name: string; args: string[] }} pull */
const pullWithRetries = async ({ name, args }) => {
  const started = performance.now();
  for (let attempt = 1; ; attempt += 1) {
    const tried = performance.now();
    try {
      await run("docker", args, { cwd: root, timeout: ATTEMPT_TIMEOUT_MS });
      console.log(`Pulled ${name} in ${seconds(started)}.`);
      return;
    } catch (error) {
      const { stderr, message } = /** @type {Error & { stderr?: string }} */ (
        error
      );
      const reason = (stderr || message).trim();
      console.log(
        `Pulling ${name} failed after ${seconds(tried)} (attempt ${attempt} of ${ATTEMPTS}): ${reason}`,
      );
      if (attempt === ATTEMPTS) {
        throw new Error(`Could not pull ${name}.`, { cause: error });
      }
      await new Promise((resolve) => setTimeout(resolve, 10_000 * attempt));
    }
  }
};

if (pulls.length === 0) {
  console.log(`Group "${group.name}" lists no Docker images.`);
} else {
  const started = performance.now();
  await Promise.all(pulls.map(pullWithRetries));
  console.log(`Pulled every image of "${group.name}" in ${seconds(started)}.`);
  if (process.env.GITHUB_ENV) {
    await appendFile(process.env.GITHUB_ENV, "HOT_UPDATER_DOCKER_PULL=never\n");
  }
}
