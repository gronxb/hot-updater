import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

export const octaneCommit = "c31f629185f7d768c821557f6fb49dc46daf671c";
export const octaneRepository = "https://github.com/octanejs/octane.git";

const exampleRoot = fileURLToPath(new URL("..", import.meta.url));
const run = promisify(execFile);

async function verifyCheckout(target) {
  const [{ stdout: head }, { stdout: changed }] = await Promise.all([
    run("git", ["rev-parse", "HEAD"], { cwd: target }),
    run("git", ["status", "--porcelain", "--untracked-files=no"], {
      cwd: target,
    }),
  ]);
  if (head.trim() !== octaneCommit || changed.trim()) {
    throw new Error(`Octane checkout must be clean at ${octaneCommit}`);
  }
}

export async function preparePinnedOctane() {
  const target = path.join(exampleRoot, ".hot-updater/octane-c31f629");
  try {
    await verifyCheckout(target);
  } catch (error) {
    const exists = await fs.access(target).then(
      () => true,
      () => false,
    );
    if (exists) throw error;
    await fs.mkdir(path.dirname(target), { recursive: true });
    const temporary = await fs.mkdtemp(`${target}.prepare-`);
    try {
      await run("git", ["init", temporary]);
      await run("git", ["remote", "add", "origin", octaneRepository], {
        cwd: temporary,
      });
      await run("git", ["fetch", "--depth=1", "origin", octaneCommit], {
        cwd: temporary,
        maxBuffer: 10 * 1024 * 1024,
      });
      await run("git", ["checkout", "--detach", octaneCommit], {
        cwd: temporary,
      });
      await run(
        "corepack",
        ["pnpm", "install", "--frozen-lockfile", "--ignore-scripts"],
        { cwd: temporary, maxBuffer: 10 * 1024 * 1024 },
      );
      await verifyCheckout(temporary);
      await fs.rename(temporary, target);
    } catch (error) {
      await fs.rm(temporary, { recursive: true, force: true });
      throw error;
    }
  }
  await fs.access(
    path.join(
      target,
      "packages/rspeedy-plugin-octane/node_modules/.bin/rspeedy",
    ),
  );
  return target;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  console.log(await preparePinnedOctane());
}
