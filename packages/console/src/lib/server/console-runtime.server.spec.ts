// @vitest-environment node

import { mockDatabase, mockStorage } from "@hot-updater/mock";
import { describe, expect, it, vi } from "vitest";

import type { HotUpdaterConsoleConfigSource } from "../../index";
import { resolveConsoleConfig } from "./console-runtime.server";

const configModule = vi.hoisted(() => ({
  source: undefined as HotUpdaterConsoleConfigSource | undefined,
}));

vi.mock("virtual:hot-updater-console/config", () => ({
  get default() {
    return configModule.source;
  },
}));

describe("Console config resolution", () => {
  it.each(["object", "callback"])(
    "resolves a %s config without reading or retaining signing settings",
    async (sourceType) => {
      const request = new Request("https://console.example.com/");
      const expected = {
        console: { gitUrl: "https://github.com/example/app" },
        database: mockDatabase({ latency: { min: 0, max: 0 } }),
        storage: mockStorage({}),
      };
      const readSigning = vi.fn(() => ({
        enabled: true,
        privateKeyPath: "/secret/private-key.pem",
      }));
      const config = {
        ...expected,
        get signing() {
          return readSigning();
        },
      };
      const source = vi.fn(async () => config);
      configModule.source = sourceType === "object" ? config : source;

      await expect(resolveConsoleConfig(request)).resolves.toEqual(expected);
      expect(readSigning).not.toHaveBeenCalled();
      if (sourceType === "callback") {
        expect(source).toHaveBeenCalledWith(request);
      }
    },
  );
});
