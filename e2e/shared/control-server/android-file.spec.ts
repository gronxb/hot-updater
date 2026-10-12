import { spawnSync } from "node:child_process";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { readAndroidFileBuffer } from "./android-file.ts";

vi.mock("node:child_process", () => ({ spawnSync: vi.fn() }));

const appId = "com.hotupdater.lynxexample";
const serial = "emulator-5598";
const file = "files/lynx-background-result.json";

describe("Android binary evidence", () => {
  beforeEach(() => {
    vi.mocked(spawnSync).mockReset();
  });

  it("keeps a missing observation pending instead of reading exec-out's error text as bytes", () => {
    vi.mocked(spawnSync).mockImplementation((_command, args) => {
      const legacy = args.includes("exec-out");
      const diagnostic = Buffer.from(
        `cat: ${file}: No such file or directory\n`,
      );
      return {
        pid: 1,
        status: legacy ? 0 : 1,
        signal: null,
        output: [],
        stdout: legacy ? diagnostic : Buffer.alloc(0),
        stderr: legacy ? Buffer.alloc(0) : diagnostic,
      };
    });
    const result = readAndroidFileBuffer(serial, appId, file);
    expect(result.fileBuffer).toBeNull();
    expect(result.readError).toContain("No such file or directory");
  });

  it.each(["/data/data", "/data/user/0"])(
    "preserves binary artifact bytes from %s without a PTY",
    (prefix) => {
      const bytes = Buffer.from([0, 255, 13, 10, 0, 10, 128]);
      vi.mocked(spawnSync).mockReturnValue({
        pid: 1,
        status: 0,
        signal: null,
        output: [],
        stdout: bytes,
        stderr: Buffer.alloc(0),
      });
      expect(
        readAndroidFileBuffer(
          serial,
          appId,
          `${prefix}/${appId}/files/main.bundle`,
        ),
      ).toEqual({ fileBuffer: bytes, readError: null });
      expect(spawnSync).toHaveBeenCalledWith(
        "adb",
        [
          "-s",
          serial,
          "shell",
          "-T",
          "run-as",
          appId,
          "cat",
          "files/main.bundle",
        ],
        expect.any(Object),
      );
    },
  );

  it("does not turn a disconnected transport's partial stdout into a file", () => {
    vi.mocked(spawnSync).mockReturnValue({
      pid: 1,
      status: null,
      signal: "SIGTERM",
      output: [],
      stdout: Buffer.from('{"success":true}'),
      stderr: Buffer.from("device disconnected"),
    });
    expect(readAndroidFileBuffer(serial, appId, file)).toEqual({
      fileBuffer: null,
      readError: "device disconnected | device disconnected",
    });
  });
});
