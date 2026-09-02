import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { InsightsCapabilityState } from "@/lib/insights-api";

import { AppSidebar } from "./AppSidebar";

let pathname = "/";
let insightsCapability: InsightsCapabilityState = { status: "unresolved" };
let apiKeysSupported = false;

vi.mock("@tanstack/react-router", () => ({
  Link: ({
    children,
    to,
    ...props
  }: {
    children: ReactNode;
    to: string;
    "data-active"?: string;
  }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
  useRouterState: () => ({ location: { pathname } }),
}));

vi.mock("@/components/ThemeProvider", () => ({
  useTheme: () => ({ theme: "dark", setTheme: vi.fn() }),
}));

vi.mock("@/components/features/insights/InsightsCapabilityContext", () => ({
  useInsightsCapability: () => insightsCapability,
}));

vi.mock("@/lib/api-keys-api", () => ({
  useApiKeyCapabilityQuery: () => ({
    data: { apiKeys: apiKeysSupported },
  }),
}));

vi.mock("@/components/HotUpdaterLogo", () => ({
  HotUpdaterLogo: () => <span>Logo</span>,
}));

vi.mock("@/components/ui/sidebar", () => {
  const Wrapper = ({ children }: { children?: ReactNode }) => <>{children}</>;
  const MenuButton = ({
    children,
    isActive,
    render,
  }: {
    children?: ReactNode;
    isActive?: boolean;
    render?: ReactNode;
  }) =>
    React.isValidElement(render) ? (
      React.cloneElement(
        render as React.ReactElement<{
          children?: ReactNode;
          "data-active"?: string;
        }>,
        { children, "data-active": isActive ? "true" : "false" },
      )
    ) : (
      <div data-active={isActive ? "true" : "false"}>{children}</div>
    );

  return {
    Sidebar: Wrapper,
    SidebarContent: Wrapper,
    SidebarFooter: Wrapper,
    SidebarGroup: Wrapper,
    SidebarGroupContent: Wrapper,
    SidebarGroupLabel: Wrapper,
    SidebarHeader: Wrapper,
    SidebarMenu: Wrapper,
    SidebarMenuButton: MenuButton,
    SidebarMenuItem: Wrapper,
  };
});

const capability = (
  status: InsightsCapabilityState["status"],
): InsightsCapabilityState => {
  switch (status) {
    case "error":
      return { status, error: new Error("offline") };
    case "supported":
      return { status, mode: "bounded", maxMatchingRows: 50_000 };
    case "unsupported":
    case "unresolved":
      return { status };
  }
};

const renderSidebar = (capabilityState: InsightsCapabilityState) => {
  insightsCapability = capabilityState;
  return render(<AppSidebar />);
};

describe("AppSidebar insights navigation", () => {
  afterEach(() => {
    cleanup();
    pathname = "/";
    apiKeysSupported = false;
  });

  it.each(["unresolved", "unsupported", "error"] as const)(
    "keeps Bundles as the primary destination while capability is %s",
    (status) => {
      renderSidebar(capability(status));

      expect(screen.getByRole("link", { name: /bundles/i })).toBeDefined();
      expect(screen.queryByRole("link", { name: /releases/i })).toBeNull();
      expect(screen.queryByRole("link", { name: /insights/i })).toBeNull();
      expect(screen.queryByRole("link", { name: /installations/i })).toBeNull();
    },
  );

  it("shows API keys only when the official database domain is available", () => {
    const rendered = renderSidebar(capability("supported"));
    expect(screen.queryByRole("link", { name: /api keys/i })).toBeNull();

    rendered.unmount();
    apiKeysSupported = true;
    renderSidebar(capability("supported"));

    expect(
      screen.getByRole("link", { name: /api keys/i }).getAttribute("href"),
    ).toBe("/api-keys");
  });

  it("marks API keys active on its route", () => {
    pathname = "/api-keys";
    apiKeysSupported = true;
    renderSidebar(capability("unsupported"));

    expect(
      screen
        .getByRole("link", { name: /api keys/i })
        .getAttribute("data-active"),
    ).toBe("true");
  });

  it("always exposes the read-only Bundle signing destination", () => {
    pathname = "/signing";
    renderSidebar(capability("unsupported"));

    const signing = screen.getByRole("link", { name: /bundle signing/i });
    expect(signing.getAttribute("href")).toBe("/signing");
    expect(signing.getAttribute("data-active")).toBe("true");
  });

  it("shows one Insights destination after support is confirmed", () => {
    renderSidebar(capability("supported"));

    expect(
      screen.getByRole("link", { name: /insights/i }).getAttribute("href"),
    ).toBe("/insights");
    expect(screen.queryByRole("link", { name: /installations/i })).toBeNull();
  });

  it.each(["/insights", "/installations"])(
    "marks Insights active on %s",
    (route) => {
      pathname = route;
      renderSidebar(capability("supported"));

      expect(
        screen
          .getByRole("link", { name: /insights/i })
          .getAttribute("data-active"),
      ).toBe("true");
    },
  );
});
