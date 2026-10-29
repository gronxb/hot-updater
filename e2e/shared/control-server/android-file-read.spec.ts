import { describe, expect, it, vi } from "vitest";

import {
  ADB_READ_RETRY_DELAY_MS,
  type AdbReadResult,
  readWithRetries,
} from "./android-file-read.ts";

const ok = (text: string): AdbReadResult => ({
  status: 0,
  stdout: Buffer.from(text),
  stderr: Buffer.alloc(0),
});

const failed = (message: string): AdbReadResult => ({
  status: 1,
  stdout: Buffer.alloc(0),
  stderr: Buffer.from(message),
});

const ATTEMPTS = [
  { args: ["exec-out", "run-as", "cat", "files/a.bmp"], retries: 1 },
  { args: ["shell", "run-as", "cat", "files/a.bmp"] },
  { args: ["shell", "cat", "/data/data/app/files/a.bmp"] },
];

describe("readWithRetries", () => {
  it("reads a file again once after exec-out fails fast, before any fallback", () => {
    const run = vi
      .fn<(args: readonly string[]) => AdbReadResult>()
      .mockReturnValueOnce(failed("adb: error: closed"))
      .mockReturnValueOnce(ok("bmp bytes"));
    const wait = vi.fn();

    const result = readWithRetries(ATTEMPTS, run, wait);

    expect(result.fileBuffer?.toString()).toBe("bmp bytes");
    expect(result.readError).toBeNull();
    expect(run.mock.calls.map(([args]) => args)).toEqual([
      ATTEMPTS[0]!.args,
      ATTEMPTS[0]!.args,
    ]);
    expect(wait).toHaveBeenCalledExactlyOnceWith(ADB_READ_RETRY_DELAY_MS);
  });

  it("falls back after the retry fails too, keeping every error in order", () => {
    const run = vi
      .fn<(args: readonly string[]) => AdbReadResult>()
      .mockReturnValueOnce(failed("closed"))
      .mockReturnValueOnce(failed("closed again"))
      .mockReturnValueOnce(failed("run-as: not debuggable"))
      .mockReturnValueOnce(ok("from shell cat"));
    const wait = vi.fn();

    const result = readWithRetries(ATTEMPTS, run, wait);

    expect(result.fileBuffer?.toString()).toBe("from shell cat");
    expect(run).toHaveBeenCalledTimes(4);
    // Only the attempt with retries waits.
    expect(wait).toHaveBeenCalledTimes(1);
  });

  it("returns every error when no way reads the file", () => {
    const run = vi.fn(
      (): AdbReadResult => ({
        status: null,
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
        error: new Error("spawnSync adb ENOBUFS"),
      }),
    );

    expect(readWithRetries(ATTEMPTS, run, vi.fn())).toEqual({
      fileBuffer: null,
      readError: Array(4).fill("spawnSync adb ENOBUFS").join(" | "),
    });
  });

  it("returns the bytes it read as they are: the hash check stays the caller's", () => {
    const run = vi.fn(() => ok("different bytes"));
    const wait = vi.fn();

    expect(readWithRetries(ATTEMPTS, run, wait).fileBuffer?.toString()).toBe(
      "different bytes",
    );
    expect(run).toHaveBeenCalledTimes(1);
    expect(wait).not.toHaveBeenCalled();
  });
});
