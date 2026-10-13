import { execa } from "execa";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createAzureCli } from "./azureCli";

vi.mock("execa", async (importOriginal) => ({
  ...(await importOriginal<typeof import("execa")>()),
  execa: vi.fn(),
}));

const run = vi.mocked(execa);

beforeEach(() => {
  run.mockReset();
  run.mockResolvedValue({ stdout: "[]" } as never);
});

describe("createAzureCli", () => {
  it.each([
    [["group", "show", "--name", "rg"]],
    [["rest", "--method", "get", "--url", "https://management.azure.com/"]],
  ])(
    "scopes %j to the selected subscription, so its tenant signs the request",
    async (args) => {
      await createAzureCli("sub")(args);

      expect(run).toHaveBeenCalledWith("az", [
        ...args,
        "--subscription",
        "sub",
        "--only-show-errors",
        "--output",
        "json",
      ]);
    },
  );

  it("runs commands before a subscription is chosen without one", async () => {
    await createAzureCli()(["account", "list"]);

    expect(run).toHaveBeenCalledWith("az", [
      "account",
      "list",
      "--only-show-errors",
      "--output",
      "json",
    ]);
  });
});
