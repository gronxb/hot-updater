import { describe, expect, it } from "vitest";

import { assertAndroidPageSize } from "./android-page-size.ts";

const target = (pageSize?: number) => ({
  name: "v0.74.1",
  android: { projectDir: "android", apk: "app.apk", pageSize },
});

function fakeAdb(output: string) {
  const calls: string[][] = [];
  return {
    calls,
    execute: async (args: string[]) => {
      calls.push(args);
      return output;
    },
  };
}

describe("assertAndroidPageSize", () => {
  it("accepts a device with the page size the target needs", async () => {
    const adb = fakeAdb("4096\n");
    await assertAndroidPageSize(target(4096), "emulator-5554", {}, adb.execute);
    expect(adb.calls).toEqual([
      ["-s", "emulator-5554", "shell", "getconf", "PAGE_SIZE"],
    ]);
  });

  it("refuses a 16 KB device for a 4 KB target", async () => {
    const adb = fakeAdb("16384\n");
    await expect(
      assertAndroidPageSize(target(4096), "emulator-5554", {}, adb.execute),
    ).rejects.toThrow(
      "The v0.74.1 target needs a device with 4 KB pages; emulator-5554 uses 16 KB",
    );
  });

  it("refuses a device whose page size it can't read", async () => {
    const adb = fakeAdb("getconf: not found\n");
    await expect(
      assertAndroidPageSize(target(4096), "emulator-5554", {}, adb.execute),
    ).rejects.toThrow("Could not read emulator-5554's page size");
  });

  it("asks nothing of the device when the target needs no page size", async () => {
    const adb = fakeAdb("16384\n");
    await assertAndroidPageSize(target(), "emulator-5554", {}, adb.execute);
    expect(adb.calls).toEqual([]);
  });
});
