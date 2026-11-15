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

  it("keeps Metro's error over its stack trace", () => {
    // The shape of what a release bundle with a broken import printed,
    // Metro 0.87.1 and Expo SDK 55: the error line, its code frame, then
    // the stack.
    const all = [
      "                Welcome to Metro v0.87.1",
      "error Unable to resolve module ./missing from /app/index.js: ",
      '\u001b[0m\u001b[31m\u001b[1m>\u001b[22m\u001b[39m\u001b[90m 1 |\u001b[39m import "./missing";',
      "Error: Unable to resolve module ./missing from /app/index.js: ",
      "None of these files exist:",
      "  * missing",
      '\u001b[0m\u001b[31m\u001b[1m>\u001b[22m\u001b[39m\u001b[90m 1 |\u001b[39m import "./missing";',
      "Import stack:",
      " app/index.js",
      ...Array.from(
        { length: 10 },
        (_, i) => `    at visit (/app/node_modules/metro/src/Graph.js:${i}:1)`,
      ),
    ].join("\n");
    expect(
      commandFailedError("react-native bundle", { exitCode: 1, all }).message,
    ).toBe(
      [
        "react-native bundle exited with code 1.",
        "Error: Unable to resolve module ./missing from /app/index.js: ",
        "None of these files exist:",
        "  * missing",
        '> 1 | import "./missing";',
        "Import stack:",
        " app/index.js",
      ].join("\n"),
    );
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
