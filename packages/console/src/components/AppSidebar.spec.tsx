import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AnalyticsCapabilityState } from "@/lib/analytics-api";

import { AppSidebar } from "./AppSidebar";

let pathname = "/";
let analyticsCapability: AnalyticsCapabilityState = { status: "unresolved" };
let accessKeysSupported = false;

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

vi.mock("@/components/features/analytics/AnalyticsCapabilityContext", () => ({
  useAnalyticsCapability: () => analyticsCapability,
}));

vi.mock("@/lib/access-keys-api", () => ({
  useClientAccessKeyCapabilityQuery: () => ({
    data: { accessKeys: accessKeysSupported },
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
  status: AnalyticsCapabilityState["status"],
): AnalyticsCapabilityState => {
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

const renderSidebar = (capabilityState: AnalyticsCapabilityState) => {
  analyticsCapability = capabilityState;
  return render(<AppSidebar />);
};

describe("AppSidebar analytics navigation", () => {
  afterEach(() => {
    cleanup();
    pathname = "/";
    accessKeysSupported = false;
  });

  it.each(["unresolved", "unsupported", "error"] as const)(
    "keeps Bundles as the primary destination while capability is %s",
    (status) => {
      renderSidebar(capability(status));

      expect(screen.getByRole("link", { name: /bundles/i })).toBeDefined();
      expect(screen.queryByRole("link", { name: /releases/i })).toBeNull();
      expect(screen.queryByRole("link", { name: /analytics/i })).toBeNull();
      expect(screen.queryByRole("link", { name: /installations/i })).toBeNull();
    },
  );

  it("shows Access keys only when the official database domain is available", () => {
    const rendered = renderSidebar(capability("supported"));
    expect(screen.queryByRole("link", { name: /access keys/i })).toBeNull();

    rendered.unmount();
    accessKeysSupported = true;
    renderSidebar(capability("supported"));

    expect(
      screen.getByRole("link", { name: /access keys/i }).getAttribute("href"),
    ).toBe("/access-keys");
  });

  it("marks Access keys active on its route", () => {
    pathname = "/access-keys";
    accessKeysSupported = true;
    renderSidebar(capability("unsupported"));

    expect(
      screen
        .getByRole("link", { name: /access keys/i })
        .getAttribute("data-active"),
    ).toBe("true");
  });

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
          .getAttribute("data-active"),
      ).toBe("true");
    },
  );
});
