import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import * as React from "react";
import { toast } from "sonner";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AppSidebar } from "./AppSidebar";

let pathname = "/";
let apiKeysSupported = false;

vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

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
    ...props
  }: {
    children?: ReactNode;
    isActive?: boolean;
    render?: ReactNode;
    disabled?: boolean;
    onClick?: () => void;
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
      <button data-active={isActive ? "true" : "false"} {...props}>
        {children}
      </button>
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
    vi.unstubAllGlobals();
    vi.clearAllMocks();
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

  it("hides sign out in the local console", () => {
    render(<AppSidebar />);
    expect(screen.queryByRole("button", { name: "Sign out" })).toBeNull();
  });

  it("disables sign out while pending and lets the user retry a failed request", async () => {
    let finish!: (response: Response) => void;
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    render(<AppSidebar canSignOut />);

    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    expect(
      screen
        .getByRole("button", { name: "Signing out…" })
        .hasAttribute("disabled"),
    ).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith("/api/auth/sign-out", {
      body: "{}",
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    finish(new Response(null, { status: 503 }));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        "Sign-out failed. Please try again.",
      ),
    );
    expect(
      screen.getByRole("button", { name: "Sign out" }).hasAttribute("disabled"),
    ).toBe(false);
  });

  it.each(["/insights", "/insights/distribution", "/installations"])(
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
