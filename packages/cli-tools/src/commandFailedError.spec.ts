import { execa } from "execa";
import { describe, expect, it } from "vitest";

import { commandFailedError } from "./commandFailedError";

const failure = async (script: string) => {
  try {
    await execa(process.execPath, ["-e", script], { all: true });
  } catch (error) {
    return error;
  }
  throw new Error("the script didn't fail");
};

describe("commandFailedError", () => {
  it("names the exit code and ends with the output's last lines", async () => {
    const error = commandFailedError(
      "expo export:embed",
      await failure(
        [
          "for (let i = 1; i <= 20; i++) console.log(`line ${i}`);",
          "console.error('npm warn config production Use --omit=dev instead.');",
          "process.exit(3);",
        ].join("\n"),
      ),
    );

    expect(error).toBeInstanceOf(Error);
    const lines = error.message.split("\n");
    expect(lines[0]).toBe("expo export:embed exited with code 3.");
    expect(lines.at(-1)).toBe(
      "npm warn config production Use --omit=dev instead.",
    );
    expect(lines).toContain("line 20");
    expect(lines).not.toContain("line 1");
  });

  it("names the signal that stopped it", async () => {
    const error = commandFailedError(
      "react-native bundle",
      await failure("process.kill(process.pid, 'SIGKILL')"),
    );
    expect(error.message).toBe("react-native bundle was stopped by SIGKILL.");
  });

  it("prints a Windows NTSTATUS in hex", () => {
    // What a Node crash with an access violation exits with on Windows.
    const error = commandFailedError("expo export:embed", {
      exitCode: 3221225477,
      all: "Bundling index.js\n",
    });
    expect(error.message).toBe(
      "expo export:embed exited with code 3221225477 (0xC0000005).\nBundling index.js",
    );
  });

  it("keeps an error that isn't a command's", () => {
    const original = new Error("ENOENT: no such file");
    expect(commandFailedError("expo export:embed", original)).toBe(original);
  });
});
