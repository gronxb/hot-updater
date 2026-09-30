// @vitest-environment node

import { describe, expect, it } from "vitest";

import {
  ConsoleFeatureUnavailableError,
  consoleFeatures,
  isConsoleFeatureUnavailableError,
  resolveConsoleFeatures,
} from "./console-features";

describe("consoleFeatures", () => {
  it("maps each feature to a Hot Updater plugin, and only event reads to a self-hosted server", () => {
    expect(consoleFeatures).toEqual({
      insights: { plugin: "insights", label: "Insights", remote: true },
      insightsAnalytics: {
        plugin: "insights",
        label: "Insights",
        remote: false,
      },
      apiKeys: { plugin: "apiKeys", label: "API keys", remote: false },
    });
  });
});

describe("resolveConsoleFeatures", () => {
  it("turns on each feature whose plugin the database config runs", () => {
    expect(
      resolveConsoleFeatures(["insights", "apiKeys"], { remote: false }),
    ).toEqual({
      insights: true,
      insightsAnalytics: true,
      apiKeys: true,
    });
    expect(resolveConsoleFeatures(["insights"], { remote: false })).toEqual({
      insights: true,
      insightsAnalytics: true,
      apiKeys: false,
    });
    expect(resolveConsoleFeatures(["apiKeys"], { remote: false })).toEqual({
      insights: false,
      insightsAnalytics: false,
      apiKeys: true,
    });
  });

  it("serves only what a self-hosted server's admin API does", () => {
    expect(
      resolveConsoleFeatures(["apiKeys", "insights"], { remote: true }),
    ).toEqual({
      insights: true,
      insightsAnalytics: false,
      apiKeys: false,
    });
    expect(resolveConsoleFeatures(["apiKeys"], { remote: true })).toEqual({
      insights: false,
      insightsAnalytics: false,
      apiKeys: false,
    });
  });

  it("turns nothing on for no plugins, or for plugins no feature needs", () => {
    const none = {
      insights: false,
      insightsAnalytics: false,
      apiKeys: false,
    };

    expect(resolveConsoleFeatures([], { remote: false })).toEqual(none);
    expect(resolveConsoleFeatures(["notes"], { remote: false })).toEqual(none);
    expect(resolveConsoleFeatures([], { remote: true })).toEqual(none);
  });
});

describe("ConsoleFeatureUnavailableError", () => {
  it("is a 404 that names the plugin to add", () => {
    const error = new ConsoleFeatureUnavailableError("apiKeys", {
      remote: false,
    });

    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({
      name: "ConsoleFeatureUnavailableError",
      feature: "apiKeys",
      status: 404,
      message: "The server runs without the apiKeys() plugin.",
    });
  });

  it("says a self-hosted server's console reads no database, for a feature that needs one", () => {
    expect(
      new ConsoleFeatureUnavailableError("insightsAnalytics", { remote: true })
        .message,
    ).toContain("reaches a self-hosted server through its admin API");
    expect(
      new ConsoleFeatureUnavailableError("insights", { remote: true }).message,
    ).toBe("The server runs without the insights() plugin.");
  });

  it("is recognized from what reaches the client, where the class does not", () => {
    const thrown = new ConsoleFeatureUnavailableError("insights", {
      remote: false,
    });
    // A server function's error reaches the client as an Error with its name
    // and own properties.
    const received = Object.assign(new Error(thrown.message), {
      name: thrown.name,
      feature: thrown.feature,
      status: thrown.status,
    });

    expect(isConsoleFeatureUnavailableError(thrown)).toBe(true);
    expect(isConsoleFeatureUnavailableError(received)).toBe(true);
    expect(isConsoleFeatureUnavailableError(new Error("Offline"))).toBe(false);
    expect(
      isConsoleFeatureUnavailableError(
        Object.assign(new Error("x"), {
          name: "ConsoleFeatureUnavailableError",
          feature: "billing",
        }),
      ),
    ).toBe(false);
    expect(
      isConsoleFeatureUnavailableError({
        name: "ConsoleFeatureUnavailableError",
        feature: "insights",
      }),
    ).toBe(false);
  });
});
