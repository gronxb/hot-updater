import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let root: string;

vi.mock("@hot-updater/cli-tools", () => ({ getCwd: () => root }));

import { resolveSandboxApplicationId } from "./getAndroidVersion";

const writeGradle = (contents: string, file = "build.gradle") => {
  const target = path.join(root, "android/app", file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents);
};

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "sandbox-id-"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const GROOVY = `
android {
  defaultConfig {
    applicationId "com.example.app"
    applicationIdSuffix ".base"
  }
  buildTypes {
    release { applicationIdSuffix ".rel" }
    debug { applicationIdSuffix ".debug" }
  }
  productFlavors {
    staging { applicationIdSuffix ".staging" }
    prod { }
    brand { applicationId "com.example.brand" }
  }
}
`;

describe("resolveSandboxApplicationId", () => {
  it("falls back to the scheme's ID without a readable Gradle file", async () => {
    expect(
      await resolveSandboxApplicationId({ packageName: "com.example" }),
    ).toBe("com.example.sandbox");
    expect(
      await resolveSandboxApplicationId({
        packageName: "com.example",
        applicationId: "com.example.custom",
      }),
    ).toBe("com.example.custom.sandbox");
  });

  it("places the sandbox's suffix after defaultConfig's, before a flavor's and a build type's, as AGP does", async () => {
    writeGradle(GROOVY);
    expect(
      await resolveSandboxApplicationId({
        packageName: "ignored",
        variant: "stagingRelease",
      }),
    ).toBe("com.example.app.base.sandbox.staging.rel");
    expect(
      await resolveSandboxApplicationId({
        packageName: "ignored",
        variant: "prodRelease",
      }),
    ).toBe("com.example.app.base.sandbox.rel");
  });

  it("takes a flavor's own application ID", async () => {
    writeGradle(GROOVY);
    expect(
      await resolveSandboxApplicationId({
        packageName: "ignored",
        variant: "brandRelease",
      }),
    ).toBe("com.example.brand.base.sandbox.rel");
  });

  it("reads the Kotlin DSL too", async () => {
    writeGradle(
      `
android {
  defaultConfig {
    applicationId = "com.example.kts"
  }
  buildTypes {
    getByName("release") { applicationIdSuffix = "rel" }
  }
  productFlavors {
    create("staging") { applicationIdSuffix = ".staging" }
  }
}
`,
      "build.gradle.kts",
    );
    expect(
      await resolveSandboxApplicationId({
        packageName: "ignored",
        variant: "stagingRelease",
      }),
    ).toBe("com.example.kts.sandbox.staging.rel");
  });
});
