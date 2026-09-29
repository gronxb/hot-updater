import { Link, useRouterState } from "@tanstack/react-router";
import {
  ChartNoAxesCombined,
  KeyRound,
  LogOut,
  Moon,
  Package,
  Sun,
} from "lucide-react";
import { type ReactElement, type ReactNode, useState } from "react";
import { toast } from "sonner";

import { HotUpdaterLogo } from "@/components/HotUpdaterLogo";
import { useTheme } from "@/components/ThemeProvider";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar";
import type { ConsoleFeature } from "@/lib/console-features";
import { useConsoleFeatures } from "@/lib/console-features-api";

type NavigationItem = {
  readonly label: string;
  readonly icon: ReactNode;
  /** The feature the item needs; it shows only while that feature is on. */
  readonly feature?: ConsoleFeature;
  readonly active: boolean;
  readonly link: ReactElement;
};

export function AppSidebar({ canSignOut = false }: { canSignOut?: boolean }) {
  const { setOpenMobile } = useSidebar();
  const closeMobileSidebar = () => setOpenMobile(false);
  const [signingOut, setSigningOut] = useState(false);
  const features = useConsoleFeatures().data?.features;
  const { theme, setTheme } = useTheme();
  const routerState = useRouterState();
  const currentPath = routerState.location.pathname;

  const navigation: readonly NavigationItem[] = [
    {
      label: "Bundles",
      icon: <Package />,
      active: currentPath === "/",
      link: (
        <Link
          to="/"
          onClick={closeMobileSidebar}
          search={{
            afterReleaseId: undefined,
            beforeReleaseId: undefined,
            channelId: undefined,
            enabled: undefined,
            releaseId: undefined,
            platform: undefined,
            bundleId: undefined,
            scopeKey: undefined,
          }}
        />
      ),
    },
    {
      label: "Insights",
      icon: <ChartNoAxesCombined />,
      feature: "insights",
      active:
        currentPath === "/insights" ||
        currentPath === "/insights/distribution" ||
        currentPath === "/installations",
      // A self-hosted server's admin API serves events, not the overview.
      link: features?.insightsAnalytics ? (
        <Link to="/insights" onClick={closeMobileSidebar} />
      ) : (
        <Link to="/installations" onClick={closeMobileSidebar} />
      ),
    },
    {
      label: "API keys",
      icon: <KeyRound />,
      feature: "apiKeys",
      active: currentPath === "/api-keys",
      link: <Link to="/api-keys" onClick={closeMobileSidebar} />,
    },
  ];

  const signOut = async () => {
    setSigningOut(true);
    try {
      const response = await fetch("/api/auth/sign-out", {
        body: "{}",
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      if (!response.ok) throw new Error("Sign-out failed. Please try again.");
      window.location.reload();
    } catch {
      setSigningOut(false);
      toast.error("Sign-out failed. Please try again.");
    }
  };

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader className="h-12 justify-center">
        <Link
          to="/"
          onClick={closeMobileSidebar}
          search={{
            afterReleaseId: undefined,
            beforeReleaseId: undefined,
            channelId: undefined,
            enabled: undefined,
            releaseId: undefined,
            platform: undefined,
            bundleId: undefined,
            scopeKey: undefined,
          }}
          className="flex items-center gap-3 p-1 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:p-2"
        >
          <HotUpdaterLogo className="h-7 w-7 shrink-0" />
          <div className="flex flex-col gap-0 group-data-[collapsible=icon]:hidden">
            <span className="text-sm font-semibold tracking-tight text-sidebar-foreground leading-tight">
              Hot Updater
            </span>
            <span className="text-[10px] text-sidebar-foreground/60 leading-tight">
              Console
            </span>
          </div>
        </Link>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Navigation</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {navigation
                .filter(
                  ({ feature }) =>
                    feature === undefined || features?.[feature] === true,
                )
                .map((item) => (
                  <SidebarMenuItem key={item.label}>
                    <SidebarMenuButton
                      isActive={item.active}
                      render={item.link}
                      tooltip={item.label}
                    >
                      {item.icon}
                      <span>{item.label}</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter>
        <SidebarMenu>
          {canSignOut ? (
            <SidebarMenuItem>
              <SidebarMenuButton
                disabled={signingOut}
                onClick={() => void signOut()}
                tooltip="Sign out"
              >
                <LogOut />
                <span>{signingOut ? "Signing out…" : "Sign out"}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          ) : null}
          <SidebarMenuItem>
            <SidebarMenuButton
              onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
              tooltip={theme === "dark" ? "Light mode" : "Dark mode"}
            >
              {theme === "dark" ? (
                <Sun className="h-4 w-4" />
              ) : (
                <Moon className="h-4 w-4" />
              )}
              <span>{theme === "dark" ? "Light mode" : "Dark mode"}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  );
}
