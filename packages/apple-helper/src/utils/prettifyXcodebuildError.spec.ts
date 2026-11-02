import { BuildFailedError } from "@hot-updater/cli-tools";
import { describe, expect, it } from "vitest";

import { prettifyXcodebuildError } from "./prettifyXcodebuildError";

const failed = (summary: string[]) =>
  new BuildFailedError("Export failed: xcodebuild exited with code 70.", {
    logPath: ".hot-updater/log/export.log",
    summary,
  });

describe("prettifyXcodebuildError", () => {
  it("names the agreement to accept when Apple holds the team's requests", () => {
    const error = prettifyXcodebuildError(
      failed([
        "error: exportArchive Unable to process request - PLA Update available",
        'error: exportArchive No signing certificate "iOS Distribution" found',
        "** EXPORT FAILED **",
      ]),
    );

    expect(error).toBeInstanceOf(BuildFailedError);
    expect(error.message).toBe(
      "The Account Holder must accept the latest Program License Agreement:\nhttps://developer.apple.com/account",
    );
    expect((error as BuildFailedError).logPath).toBe(
      ".hot-updater/log/export.log",
    );
    // The one line a command prints after the summary.
    expect((error as BuildFailedError).hint).toBe(error.message);
  });

  it("keeps xcodebuild's own failure otherwise", () => {
    const error = prettifyXcodebuildError(
      failed(["error: exportArchive Some other failure"]),
    );

    expect(error.message).toBe(
      "Export failed: xcodebuild exited with code 70.",
    );
    expect((error as BuildFailedError).hint).toBeNull();
  });
});
