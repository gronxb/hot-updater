import { BuildLogger } from "@hot-updater/cli-tools";

import { createGradlePhaseReader } from "./gradlePhase";

export const createGradleLogger = ({ logPrefix }: { logPrefix: string }) =>
  new BuildLogger({
    logPrefix,
    createPhaseReader: createGradlePhaseReader,
    failureSummary: {
      lines: [
        // Kotlin's `e: file.kt:1:2 …` and javac's `File.java:1: error: …`.
        /^e: /,
        /(^|:\s)error: /,
        /^BUILD FAILED/,
      ],
      blocks: [
        { start: "* What went wrong:", end: "* Try:", includeEnd: false },
      ],
    },
  });
