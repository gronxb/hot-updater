import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AnalyticsCapabilityState } from "@/lib/analytics-api";

import { AppSidebar } from "./AppSidebar";

let pathname = "/";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to }: { children: ReactNode; to: string }) => (
    <a href={to}>{children}</a>
  ),
  useRouterState: () => ({ location: { pathname } }),
}));

vi.mock("@/components/ThemeProvider", () => ({
  useTheme: () => ({ theme: "dark", setTheme: vi.fn() }),
}));

vi.mock("@/components/HotUpdaterLogo", () => ({
  HotUpdaterLogo: () => <span>Logo</span>,
}));

vi.mock("@/components/ui/sidebar", () => {
  const Wrapper = ({ children }: { children?: ReactNode }) => <>{children}</>;
  const MenuButton = ({
    children,
    isActive,
  }: {
    children?: ReactNode;
    isActive?: boolean;
  }) => <div data-active={isActive ? "true" : "false"}>{children}</div>;

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
  status: AnalyticsCapabilityState["status"],
): AnalyticsCapabilityState => {
  switch (status) {
    case "error":
      return { status, error: new Error("offline") };
    case "supported":
      return { status, mode: "dedicated" };
    case "unsupported":
    case "unresolved":
      return { status };
  }
};

const renderSidebar = (analyticsCapability: AnalyticsCapabilityState) =>
  render(<AppSidebar analyticsCapability={analyticsCapability} />);

describe("AppSidebar analytics navigation", () => {
  afterEach(() => {
    cleanup();
    pathname = "/";
  });

  it.each(["unresolved", "unsupported", "error"] as const)(
    "shows only Bundles while capability is %s",
    (status) => {
      renderSidebar(capability(status));

      expect(screen.getByRole("link", { name: /bundles/i })).toBeDefined();
      expect(screen.queryByRole("link", { name: /analytics/i })).toBeNull();
      expect(screen.queryByRole("link", { name: /installations/i })).toBeNull();
    },
  );

  it("shows one Analytics destination after support is confirmed", () => {
    renderSidebar(capability("supported"));

    expect(
      screen.getByRole("link", { name: /analytics/i }).getAttribute("href"),
    ).toBe("/analytics");
    expect(screen.queryByRole("link", { name: /installations/i })).toBeNull();
  });

  it.each(["/analytics", "/installations"])(
    "marks Analytics active on %s",
    (route) => {
      pathname = route;
      renderSidebar(capability("supported"));

      expect(
        screen
          .getByRole("link", { name: /analytics/i })
          .parentElement?.getAttribute("data-active"),
      ).toBe("true");
    },
  );
});
