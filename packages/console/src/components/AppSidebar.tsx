import { Link, useRouterState } from "@tanstack/react-router";
import { ChartNoAxesCombined, History, Moon, Package, Sun } from "lucide-react";

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
} from "@/components/ui/sidebar";
import type { AnalyticsCapabilityState } from "@/lib/analytics-api";

export function AppSidebar({
  analyticsCapability,
}: {
  readonly analyticsCapability: AnalyticsCapabilityState;
}) {
  const { theme, setTheme } = useTheme();
  const routerState = useRouterState();
  const currentPath = routerState.location.pathname;

  const isBundlesActive = currentPath === "/";
  const isAnalyticsActive = currentPath === "/analytics";
  const isInstallationsActive = currentPath === "/installations";
  const showAnalyticsNavigation = analyticsCapability.status === "supported";

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader className="h-12 justify-center">
        <Link
          to="/"
          search={{
            channel: undefined,
            platform: undefined,
            page: undefined,
            after: undefined,
            before: undefined,
            bundleId: undefined,
            expandedBundleId: undefined,
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
              <SidebarMenuItem>
                <SidebarMenuButton
                  asChild
                  isActive={isBundlesActive}
                  tooltip="Bundles"
                >
                  <Link
                    to="/"
                    search={{
                      channel: undefined,
                      platform: undefined,
                      page: undefined,
                      after: undefined,
                      before: undefined,
                      bundleId: undefined,
                      expandedBundleId: undefined,
                    }}
                  >
                    <Package />
                    <span>Bundles</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
              {showAnalyticsNavigation ? (
                <>
                  <SidebarMenuItem>
                    <SidebarMenuButton
                      asChild
                      isActive={isAnalyticsActive}
                      tooltip="Analytics"
                    >
                      <Link to="/analytics">
                        <ChartNoAxesCombined />
                        <span>Analytics</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                  <SidebarMenuItem>
                    <SidebarMenuButton
                      asChild
                      isActive={isInstallationsActive}
                      tooltip="Installations"
                    >
                      <Link
                        to="/installations"
                        search={{
                          query: undefined,
                          installId: undefined,
                        }}
                      >
                        <History />
                        <span>Installations</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                </>
              ) : null}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter>
        <SidebarMenu>
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
