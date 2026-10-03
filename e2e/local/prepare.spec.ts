import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { describe, expect, it } from "vitest";

import { localCommand } from "./prepare.ts";

describe("local preparation cancellation", () => {
  it("kills an owned compiler descendant even when its wrapper exits on SIGTERM", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hu-local-cancel-"));
    const pidPath = path.join(dir, "child.pid");
    const cancellation = new AbortController();
    let descendant: number | undefined;
    const childScript = `require("node:fs").writeFileSync(process.argv[1], String(process.pid)); process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);`;
    const wrapper = `require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(childScript)}, process.argv[1]], { stdio: "inherit" }); process.on("SIGTERM", () => process.exit(0)); setInterval(() => {}, 1000);`;
    const command = localCommand(process.execPath, ["-e", wrapper, pidPath], {
      cwd: dir,
      env: process.env,
      signal: cancellation.signal,
      capture: true,
    });
    // Attach the rejection handler before requesting cancellation.
    const result = command.catch((error: unknown) => error);
    try {
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        try {
          descendant = Number(await fs.readFile(pidPath, "utf8"));
          break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          await sleep(20);
        }
      }
      expect(descendant).toBeGreaterThan(0);
      cancellation.abort(new Error("cancel during native build"));
      expect(await result).toMatchObject({
        message: "cancel during native build",
      });
      await expect
        .poll(
          () => {
            try {
              process.kill(descendant!, 0);
              return true;
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ESRCH")
                throw error;
              return false;
            }
          },
          { timeout: 5_000 },
        )
        .toBe(false);
    } finally {
      cancellation.abort();
      await result;
      if (descendant) {
        try {
          process.kill(descendant, "SIGKILL");
        } catch {
          /* Already stopped. */
        }
      }
      await fs.rm(dir, { recursive: true, force: true });
    }
  }, 15_000);
});
