#!/usr/bin/env node

import { runE2e } from "../../run.ts";

// The dedicated Lynx commands consume the caller's provider and Release build.
// Device ownership, SDK results, cancellation and cleanup belong to one runner.
runE2e(["--prepared", "--runtime", "lynx", ...process.argv.slice(2)]).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  },
);
