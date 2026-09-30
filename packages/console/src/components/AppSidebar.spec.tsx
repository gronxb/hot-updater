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

import type { ConsoleFeatures } from "@/lib/console-features";

import { AppSidebar } from "./AppSidebar";

const allOff: ConsoleFeatures = {
  insights: false,
  insightsAnalytics: false,
  apiKeys: false,
};
const allOn: ConsoleFeatures = {
  insights: true,
  insightsAnalytics: true,
  apiKeys: true,
};

let pathname = "/";
let features: ConsoleFeatures | undefined = allOff;
const setOpenMobile = vi.fn();

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

vi.mock("@/lib/console-features-api", () => ({
  useConsoleFeatures: () => ({
    data: features === undefined ? undefined : { features, remote: false },
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
    useSidebar: () => ({ setOpenMobile }),
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
    features = allOff;
  });

  it.each([/hot updater/i, /bundles/i, /insights/i, /api keys/i])(
    "closes the mobile sidebar when selecting %s",
    (name) => {
      features = allOn;
      render(<AppSidebar />);
      fireEvent.click(screen.getByRole("link", { name }));
      expect(setOpenMobile).toHaveBeenCalledWith(false);
    },
  );

  it.each([
    ["no plugins", ["Bundles"], allOff],
    [
      "insights() over the database",
      ["Bundles", "Insights"],
      { ...allOff, insights: true, insightsAnalytics: true },
    ],
    [
      "insights() on a self-hosted server",
      ["Bundles", "Insights"],
      { ...allOff, insights: true },
    ],
    ["apiKeys()", ["Bundles", "API keys"], { ...allOff, apiKeys: true }],
    ["every plugin", ["Bundles", "Insights", "API keys"], allOn],
    ["the features still loading", ["Bundles"], undefined],
  ] as const)("with %s, shows %j", (_case, labels, served) => {
    features = served;
    render(<AppSidebar />);

    const shown = ["Bundles", "Insights", "API keys"].filter(
      (label) => screen.queryByRole("link", { name: label }) !== null,
    );
    expect(shown).toEqual(labels);
    expect(screen.queryByRole("link", { name: /installations/i })).toBeNull();
  });

  it("opens Insights on the overview with usage, and on All events without", () => {
    features = { ...allOff, insights: true, insightsAnalytics: true };
    const view = render(<AppSidebar />);
    expect(
      screen.getByRole("link", { name: /insights/i }).getAttribute("href"),
    ).toBe("/insights");
    view.unmount();

    // A self-hosted server's admin API serves events, not the overview.
    features = { ...allOff, insights: true };
    render(<AppSidebar />);
    expect(
      screen.getByRole("link", { name: /insights/i }).getAttribute("href"),
    ).toBe("/installations");
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
      features = allOn;
      render(<AppSidebar />);
      expect(
        screen
          .getByRole("link", { name: /insights/i })
          .getAttribute("data-active"),
      ).toBe("true");
    },
  );

  it("links API keys to their page", () => {
    features = { ...allOff, apiKeys: true };
    render(<AppSidebar />);
    expect(
      screen.getByRole("link", { name: /api keys/i }).getAttribute("href"),
    ).toBe("/api-keys");
  });

  it.each([false, true])(
    "omits Bundle signing when canSignOut is %s",
    (canSignOut) => {
      render(<AppSidebar canSignOut={canSignOut} />);

      expect(
        screen.queryByRole("link", { name: /bundle signing/i }),
      ).toBeNull();
    },
  );
});
