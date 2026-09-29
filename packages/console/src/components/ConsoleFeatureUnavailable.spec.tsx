import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CONSOLE_DEPLOYMENT_GUIDE_URL,
  ConsoleFeatureUnavailable,
} from "./ConsoleFeatureUnavailable";

const mocks = vi.hoisted(() => ({ remote: false }));

vi.mock("@/lib/console-features-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/console-features-api")>()),
  useConsoleFeatures: () => ({
    data: {
      features: { insights: false, insightsAnalytics: false, apiKeys: false },
      remote: mocks.remote,
    },
  }),
}));
vi.mock("@/components/ui/sidebar", () => ({ SidebarTrigger: () => null }));
vi.mock("@/components/NotFoundPage", () => ({
  NotFoundPage: () => <h1>Page not found</h1>,
}));

const description = () =>
  document.querySelector("[data-slot=empty-description]")?.textContent;

describe("ConsoleFeatureUnavailable", () => {
  afterEach(() => {
    cleanup();
    mocks.remote = false;
  });

  it("names the plugin to add where the server and the console config list plugins", () => {
    render(<ConsoleFeatureUnavailable data={{ feature: "insights" }} />);

    expect(screen.getByRole("heading", { name: "Insights" })).toBeDefined();
    expect(screen.getByText("Insights not installed")).toBeDefined();
    expect(description()).toBe(
      "Add insights() to plugins where you create the server and in the console config.",
    );
    const guide = screen.getByRole("link", { name: /console setup guide/i });
    expect(guide.getAttribute("href")).toBe(CONSOLE_DEPLOYMENT_GUIDE_URL);
    expect(guide.getAttribute("target")).toBe("_blank");
  });

  it("names apiKeys() for API keys", () => {
    render(<ConsoleFeatureUnavailable data={{ feature: "apiKeys" }} />);

    expect(screen.getByText("API keys not installed")).toBeDefined();
    expect(description()).toContain("Add apiKeys() to plugins");
  });

  it("points a self-hosted server's console at the server's plugins", () => {
    mocks.remote = true;
    render(<ConsoleFeatureUnavailable data={{ feature: "insights" }} />);

    expect(description()).toBe(
      "Add insights() to plugins where you create the server.",
    );
  });

  it.each(["insightsAnalytics", "apiKeys"])(
    "says %s needs the server's database on a self-hosted server's console",
    (feature) => {
      mocks.remote = true;
      render(<ConsoleFeatureUnavailable data={{ feature }} />);

      expect(screen.getByText("Needs the server's database")).toBeDefined();
      expect(description()).toContain(
        "Configure the console with the database the server uses.",
      );
    },
  );

  it("is the plain not-found page for any other not-found", () => {
    render(<ConsoleFeatureUnavailable data={{ feature: "billing" }} />);

    expect(
      screen.getByRole("heading", { name: "Page not found" }),
    ).toBeDefined();
  });
});
