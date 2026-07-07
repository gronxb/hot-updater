// @vitest-environment node

import type {
  DatabasePlugin,
  NodeStoragePlugin,
  RuntimeStoragePlugin,
} from "@hot-updater/plugin-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  ConsoleCapabilityError,
  createConsoleCapabilities,
  requireNodeStorageOperation,
} from "./capabilities.server";

const { setResponseStatusMock } = vi.hoisted(() => ({
  setResponseStatusMock: vi.fn(),
}));

vi.mock("@tanstack/react-start/server", () => ({
  setResponseStatus: setResponseStatusMock,
}));

function createDatabasePlugin(): DatabasePlugin {
  return {
    name: "database",
    getBundleById: vi.fn(),
    getBundles: vi.fn(),
    getChannels: vi.fn(),
    updateBundle: vi.fn(),
    appendBundle: vi.fn(),
    deleteBundle: vi.fn(),
    commitBundle: vi.fn(),
  };
}

function createNodeStoragePlugin(): NodeStoragePlugin {
  return {
    name: "nodeStorage",
    supportedProtocol: "s3",
    profiles: {
      node: {
        upload: vi.fn(),
        exists: vi.fn(async () => false),
        delete: vi.fn(),
        downloadFile: vi.fn(),
      },
    },
  };
}

function createRuntimeStoragePlugin(): RuntimeStoragePlugin {
  return {
    name: "runtimeStorage",
    supportedProtocol: "s3",
    profiles: {
      runtime: {
        getDownloadUrl: vi.fn(),
        readText: vi.fn(),
      },
    },
  };
}

describe("console capabilities", () => {
  beforeEach(() => {
    setResponseStatusMock.mockReset();
  });

  it("keeps database-only move operations available with runtime-only storage", () => {
    const capabilities = createConsoleCapabilities({
      databasePlugin: createDatabasePlugin(),
      storagePlugin: createRuntimeStoragePlugin(),
    });

    expect(capabilities.readBundles.supported).toBe(true);
    expect(capabilities.promoteBundleMove.supported).toBe(true);
    expect(capabilities.downloadBundle.supported).toBe(true);
    expect(capabilities.promoteBundleCopy.supported).toBe(false);
    expect(capabilities.deleteBundle.supported).toBe(false);
  });

  it("throws typed capability errors before node-only operations", () => {
    const dependencies = {
      databasePlugin: createDatabasePlugin(),
      storagePlugin: createRuntimeStoragePlugin(),
    };

    expect(() =>
      requireNodeStorageOperation(dependencies, "deleteBundle"),
    ).toThrow(ConsoleCapabilityError);

    try {
      requireNodeStorageOperation(dependencies, "deleteBundle");
    } catch (error) {
      expect(error).toBeInstanceOf(ConsoleCapabilityError);
      expect((error as ConsoleCapabilityError).code).toBe(
        "CONSOLE_CAPABILITY_UNSUPPORTED",
      );
      expect((error as ConsoleCapabilityError).operation).toBe("deleteBundle");
    }

    expect(setResponseStatusMock).toHaveBeenCalledWith(409);
  });

  it("returns node storage when the requested operation is supported", () => {
    const storagePlugin = createNodeStoragePlugin();

    expect(
      requireNodeStorageOperation(
        {
          databasePlugin: createDatabasePlugin(),
          storagePlugin,
        },
        "deleteBundle",
      ),
    ).toBe(storagePlugin);
  });
});
