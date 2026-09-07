import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AppSidebar } from "./AppSidebar";

let pathname = "/";
let apiKeysSupported = false;

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to, ...props }: { children: ReactNode; to: string }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
  useRouterState: () => ({ location: { pathname } }),
}));

vi.mock("@/components/ThemeProvider", () => ({
  useTheme: () => ({ theme: "dark", setTheme: vi.fn() }),
}));

vi.mock("@/lib/api-keys-api", () => ({
  useApiKeyCapabilityQuery: () => ({ data: { apiKeys: apiKeysSupported } }),
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

describe("AppSidebar navigation", () => {
  afterEach(() => {
    cleanup();
    pathname = "/";
    apiKeysSupported = false;
  });

  it("always exposes the canonical Insights destination", () => {
    render(<AppSidebar />);
    expect(screen.getByRole("link", { name: /bundles/i })).toBeDefined();
    expect(
      screen.getByRole("link", { name: /insights/i }).getAttribute("href"),
    ).toBe("/insights");
    expect(screen.queryByRole("link", { name: /installations/i })).toBeNull();
  });

  it.each(["/insights", "/installations"])(
    "marks Insights active on %s",
    (route) => {
      pathname = route;
      render(<AppSidebar />);
      expect(
        screen
          .getByRole("link", { name: /insights/i })
          .getAttribute("data-active"),
      ).toBe("true");
    },
  );

  it("shows API keys only when the database exposes that domain", () => {
    const view = render(<AppSidebar />);
    expect(screen.queryByRole("link", { name: /api keys/i })).toBeNull();
    view.unmount();
    apiKeysSupported = true;
    render(<AppSidebar />);
    expect(
      screen.getByRole("link", { name: /api keys/i }).getAttribute("href"),
    ).toBe("/api-keys");
  });

  it("always exposes the read-only Bundle signing destination", () => {
    pathname = "/signing";
    render(<AppSidebar />);

    const signing = screen.getByRole("link", { name: /bundle signing/i });
    expect(signing.getAttribute("href")).toBe("/signing");
    expect(signing.getAttribute("data-active")).toBe("true");
  });
});
