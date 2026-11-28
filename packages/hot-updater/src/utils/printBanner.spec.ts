import { afterEach, describe, expect, it, vi } from "vitest";

// The build defines the package's version.
vi.mock("@/packageJson", () => ({ version: "9.9.9" }));

afterEach(() => {
  vi.restoreAllMocks();
});

describe("printBanner", () => {
  it("prints the banner once per run, however many handlers call it", async () => {
    const logged = vi.spyOn(console, "log").mockImplementation(() => {});
    const { printBanner } = await import("./printBanner");

    printBanner();
    printBanner();

    expect(logged).toHaveBeenCalledTimes(1);
    expect(String(logged.mock.calls[0]![0])).toContain("v9.9.9");
  });
});
