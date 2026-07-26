import { expect, expectTypeOf, it } from "vitest";

import * as root from "./index";
import { mockStorage as storageV2 } from "./storage";

it("keeps the root mockStorage legacy facade unchanged", async () => {
  // Given
  const legacyFactory = root.mockStorage({});

  // When
  const legacyPlugin = legacyFactory();
  const upload = await legacyPlugin.profiles.node.upload(
    "release",
    "/tmp/mock-bundle.zip",
  );

  // Then
  expect(upload).toEqual({
    storageUri: "storage://my-app/release/bundle.zip",
  });
  await expect(
    legacyPlugin.profiles.node.exists("storage://my-app/release/bundle.zip"),
  ).resolves.toBe(false);
  expect(legacyPlugin).not.toHaveProperty("protocol");
  expectTypeOf(legacyFactory).toBeFunction();
});

it("keeps v2 fixture controls outside the root module", () => {
  // Given
  const rootExports = Object.keys(root);

  // When
  const plugin = storageV2();

  // Then
  expect(rootExports).not.toContain("MockStorageConfig");
  expect(plugin).toMatchObject({
    name: "mockStorage",
    protocol: "storage",
  });
  expectTypeOf(plugin).toMatchTypeOf<{
    readonly protocol: string;
  }>();
});
