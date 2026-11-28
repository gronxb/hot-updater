import { describe, expect, it, vi } from "vitest";

import {
  ADB_READ_RETRY_DELAY_MS,
  type AdbReadResult,
  readUntilComplete,
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

describe("readUntilComplete", () => {
  const read = (...sizes: number[]) => {
    const sizesLeft = [...sizes];
    return vi.fn(() => ({
      fileBuffer: Buffer.alloc(sizesLeft.shift()!),
      readError: null,
    }));
  };

  it("reads again when exec-out ended early with exit 0", () => {
    const reader = read(2_635_264, 50_331_702);
    const wait = vi.fn();

    const result = readUntilComplete(reader, 50_331_702, wait);

    expect(result.fileBuffer?.length).toBe(50_331_702);
    expect(result.readError).toBeNull();
    expect(reader).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenCalledWith(ADB_READ_RETRY_DELAY_MS);
  });

  it("reports a read that stays short, so the file's check can't pass", () => {
    const reader = read(10, 10, 10);

    const result = readUntilComplete(reader, 100, vi.fn());

    expect(result.readError).toBe("Read 10 of 100 bytes");
    expect(reader).toHaveBeenCalledTimes(3);
  });

  it("reads once when the size matches or the device can't report it", () => {
    for (const expected of [100, null]) {
      const reader = read(100);
      expect(readUntilComplete(reader, expected, vi.fn()).readError).toBeNull();
      expect(reader).toHaveBeenCalledTimes(1);
    }
  });

  it("passes a failed read through without reading again", () => {
    const reader = vi.fn(() => ({ fileBuffer: null, readError: "gone" }));

    expect(readUntilComplete(reader, 100, vi.fn())).toEqual({
      fileBuffer: null,
      readError: "gone",
    });
    expect(reader).toHaveBeenCalledTimes(1);
  });
});
