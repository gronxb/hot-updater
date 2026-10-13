import { execa } from "execa";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  type AzureCli,
  createAzureCli,
  ensureResourceProviders,
} from "./azureCli";

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

describe("ensureResourceProviders", () => {
  it("registers each provider the Flex Consumption app and its data need that is not registered yet", async () => {
    const registered = new Set(["Microsoft.Storage", "Microsoft.Web"]);
    const calls: (readonly string[])[] = [];
    const az = (async (args: readonly string[]) => {
      calls.push(args);
      return args[1] === "show"
        ? {
            registrationState: registered.has(args[3]!)
              ? "Registered"
              : "NotRegistered",
          }
        : null;
    }) as AzureCli;

    await ensureResourceProviders(az);

    expect(
      calls.filter((args) => args[1] === "register").map((args) => args[3]),
    ).toEqual(["Microsoft.DocumentDB", "Microsoft.App"]);
  });
});
