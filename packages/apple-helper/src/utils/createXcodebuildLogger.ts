import { BuildLogger } from "@hot-updater/cli-tools";

import { createXcodebuildPhaseReader } from "./xcodebuildPhase";

export const createXcodebuildLogger = ({
  logPrefix,
  logFilePath,
}: {
  logPrefix: string;
  /** The log to append to, such as the archive's for its export. */
  logFilePath?: string;
}) =>
  new BuildLogger({
    logPrefix,
    logFilePath,
    createPhaseReader: createXcodebuildPhaseReader,
    failureSummary: {
      lines: [
        // `error: …` and `File.swift:1:2: error: …`, not a warning that says
        // "this will be an error".
        /(^|:\s)error: /,
        /^\*\* [A-Z ]+ FAILED \*\*$/,
      ],
      blocks: [
        {
          start: "The following build commands failed:",
          end: /^\(\d+ failures?\)$/,
          includeEnd: true,
        },
        // An export's error, then the lines that explain it.
        { start: /^error: exportArchive /, end: /^$/, includeEnd: false },
      ],
    },
  });
