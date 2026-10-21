import { existsSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  importPublished,
  publishedBin,
  publishedConsoleServer,
} from "./published.ts";

describe("published entries", () => {
  it("runs the CLI the example app installs, through its bin", () => {
    const cli = publishedBin("hot-updater");

    expect(cli).toMatch(/[\\/]dist[\\/]index\.mjs$/u);
    expect(existsSync(cli)).toBe(true);
  });

  it("starts the console server the CLI installs, as hot-updater console does", () => {
    const server = publishedConsoleServer();

    expect(server).toMatch(/[\\/]\.output[\\/]server[\\/]index\.mjs$/u);
    expect(existsSync(server)).toBe(true);
  });

  it("refuses a command the package does not have", () => {
    expect(() => publishedBin("hot-updater", "hot-updater-server")).toThrow(
      "hot-updater has no hot-updater-server command.",
    );
  });

  it("refuses a subpath the package does not export, as Node refuses it for the app", async () => {
    await expect(importPublished("@hot-updater/server/db")).rejects.toThrow(
      "@hot-updater/server does not export ./db.",
    );
  });
});
