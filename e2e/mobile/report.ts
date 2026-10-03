import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import type { Reporter } from "e2e";

import type { MobileContext } from "./context.ts";
import { mobileResultIdentity } from "./result.ts";

export function createHotUpdaterReporter(context: MobileContext): Reporter {
  const identity = mobileResultIdentity(context);
  return {
    name: "hot-updater",
    async onRunFinished(run, signal) {
      signal.throwIfAborted();
      const target = path.join(context.resultsDir, "sdk-report.json");
      await mkdir(context.resultsDir, { recursive: true });
      await writeFile(
        `${target}.tmp`,
        `${JSON.stringify({ schemaVersion: 1, identity, report: run.report }, null, 2)}\n`,
        { signal },
      );
      signal.throwIfAborted();
      await rename(`${target}.tmp`, target);
    },
  };
}
