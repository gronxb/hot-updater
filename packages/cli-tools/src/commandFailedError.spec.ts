import { execa } from "execa";
import { afterEach, describe, expect, it } from "vitest";

import {
  commandFailedError,
  npxCommandLine,
  shellCommandLine,
} from "./commandFailedError";

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

  it("keeps a Ruby exception over its backtrace", () => {
    // What `bundle install` printed with a Gemfile.lock bundled with Bundler
    // 1.17.2, on Ruby 3.3: the exception, its code frame, then its frames.
    const gems = "/ruby/3.3.10/lib/ruby/gems/3.3.0/gems/bundler-1.17.2";
    const cause = `${gems}/lib/bundler/shared_helpers.rb:272:in \`search_up': undefined method \`untaint' for an instance of String (NoMethodError)`;
    const all = [
      cause,
      "",
      "      current  = File.expand_path(SharedHelpers.pwd).untaint",
      "                                                    ^^^^^^^^",
      ...Array.from(
        { length: 14 },
        (_, i) =>
          `\tfrom ${gems}/lib/bundler/shared_helpers.rb:${i}:in \`find_file'`,
      ),
      "\tfrom <internal:/ruby/3.3.10/lib/ruby/3.3.0/rubygems/core_ext/kernel_require.rb>:136:in `require'",
      "\tfrom /ruby/3.3.10/bin/bundle:25:in `<main>'",
    ].join("\n");
    expect(
      commandFailedError(
        "bundle install",
        { exitCode: 1, all },
        "cd ios && bundle install",
      ).message,
    ).toBe(
      [
        "bundle install exited with code 1.",
        cause,
        "      current  = File.expand_path(SharedHelpers.pwd).untaint",
        "                                                    ^^^^^^^^",
        "Run it for its full output:",
        "cd ios && bundle install",
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

  it("ends with one next step: the command to run for its full output", () => {
    const error = commandFailedError(
      "expo export:embed",
      {
        exitCode: 3221225477,
        all: "npm warn config production Use --omit=dev instead.\n",
      },
      "npx expo export:embed --platform android --dev false",
    );
    expect(error.message).toBe(
      [
        "expo export:embed exited with code 3221225477 (0xC0000005).",
        "npm warn config production Use --omit=dev instead.",
        "Run it for its full output:",
        "npx expo export:embed --platform android --dev false",
      ].join("\n"),
    );
  });

  it("keeps an error that isn't a command's", () => {
    const original = new Error("ENOENT: no such file");
    expect(commandFailedError("expo export:embed", original)).toBe(original);
  });
});

describe("shellCommandLine", () => {
  const platform = process.platform;
  afterEach(() => {
    Object.defineProperty(process, "platform", { value: platform });
  });

  it("keeps any command on one line, quoting a path outside the project", () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    const line = shellCommandLine("/work/app", [
      "node",
      "/deps/react native/scripts/generate-codegen-artifacts.js",
      "-p",
      "/work/app",
      "-o",
      "/work/app/ios",
      "-t",
      "ios",
    ]);
    expect(line).toBe(
      "node '/deps/react native/scripts/generate-codegen-artifacts.js' -p . -o ios -t ios",
    );
    expect(line).not.toContain("\n");
  });

  it("double-quotes on Windows", () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    expect(
      shellCommandLine("C:\\work\\app", [
        "node",
        "D:\\deps\\my rn\\codegen.js",
      ]),
    ).toBe('node "D:\\deps\\my rn\\codegen.js"');
  });
});

describe("npxCommandLine", () => {
  const platform = process.platform;
  afterEach(() => {
    Object.defineProperty(process, "platform", { value: platform });
  });

  it("writes the project's paths relative to it, and quotes what a shell would split", () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    expect(
      npxCommandLine("/work/my app", [
        "expo",
        "export:embed",
        "--bundle-output",
        "/work/my app/dist/index.android.bundle",
        "--entry-file",
        "src/main entry.js",
        "--assets-dest",
        "/tmp/assets",
      ]),
    ).toBe(
      "npx expo export:embed --bundle-output dist/index.android.bundle --entry-file 'src/main entry.js' --assets-dest /tmp/assets",
    );
  });

  it("keeps an apostrophe inside POSIX single quotes", () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    expect(
      npxCommandLine("/work/app", ["expo", "--entry-file", "src/it's main.js"]),
    ).toBe("npx expo --entry-file 'src/it'\\''s main.js'");
  });

  describe("on Windows, where cmd.exe reads no single quotes", () => {
    it("double-quotes a path with spaces, relative to the project", () => {
      Object.defineProperty(process, "platform", { value: "win32" });
      expect(
        npxCommandLine("C:\\src\\my app", [
          "react-native",
          "bundle",
          "--bundle-output",
          "C:\\src\\my app\\dist\\index.android.bundle",
          "--entry-file",
          "src\\main entry.js",
          "--assets-dest",
          "D:\\out dir",
        ]),
      ).toBe(
        'npx react-native bundle --bundle-output dist\\index.android.bundle --entry-file "src\\main entry.js" --assets-dest "D:\\out dir"',
      );
    });

    it("double-quotes a path with an apostrophe, which PowerShell would read as a string", () => {
      Object.defineProperty(process, "platform", { value: "win32" });
      expect(
        npxCommandLine("C:\\src\\app", [
          "expo",
          "--entry-file",
          "C:\\src\\app\\src\\it's main.js",
        ]),
      ).toBe('npx expo --entry-file "src\\it\'s main.js"');
    });
  });
});
