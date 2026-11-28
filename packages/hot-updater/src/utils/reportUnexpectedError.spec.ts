import { afterEach, expect, it, vi } from "vitest";

const printed = new WeakSet<object>();
vi.mock("@hot-updater/cli-tools", () => ({
  p: { log: { error: vi.fn() } },
  isPrintedTaskError: (error: unknown) =>
    typeof error === "object" && error !== null && printed.has(error),
}));

import { p } from "@hot-updater/cli-tools";

import { reportUnexpectedError } from "./reportUnexpectedError";

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

it("prints an error once: not again after the task that failed printed it", () => {
  const failure = new Error("expo export:embed exited with code 1.");
  printed.add(failure);

  reportUnexpectedError(failure);

  expect(p.log.error).not.toHaveBeenCalled();
});

it("still prints the whole error, with its cause, with DEBUG set", () => {
  vi.stubEnv("DEBUG", "1");
  const console = vi
    .spyOn(globalThis.console, "error")
    .mockImplementation(() => {});
  const failure = new Error("expo export:embed exited with code 1.", {
    cause: { exitCode: 1 },
  });
  printed.add(failure);

  reportUnexpectedError(failure);

  expect(console).toHaveBeenCalledWith(failure);
  console.mockRestore();
});

it("prints any other error", () => {
  reportUnexpectedError(new Error("The config has no storage."));

  expect(p.log.error).toHaveBeenCalledWith("The config has no storage.");
});
