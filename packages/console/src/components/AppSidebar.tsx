import { Link, useRouterState } from "@tanstack/react-router";
import {
  ChartNoAxesCombined,
  KeyRound,
  Moon,
  Package,
  ShieldCheck,
  Sun,
} from "lucide-react";

import { useAnalyticsCapability } from "@/components/features/analytics/AnalyticsCapabilityContext";
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
import { useClientAccessKeyCapabilityQuery } from "@/lib/access-keys-api";
export function AppSidebar() {
  const analyticsCapability = useAnalyticsCapability();
  const accessKeyCapability = useClientAccessKeyCapabilityQuery();
  const { theme, setTheme } = useTheme();
  const routerState = useRouterState();
  const currentPath = routerState.location.pathname;

  const isBundlesActive = currentPath === "/";
  const isAnalyticsActive =
    currentPath === "/analytics" || currentPath === "/installations";
  const isAccessKeysActive = currentPath === "/access-keys";
  const isSigningActive = currentPath === "/signing";

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader className="h-12 justify-center">
        <Link
          to="/"
          search={{
            afterReleaseId: undefined,
            beforeReleaseId: undefined,
            channelId: undefined,
            enabled: undefined,
            releaseId: undefined,
            platform: undefined,
            targetAppVersion: undefined,
            bundleId: undefined,
            page: undefined,
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
                  isActive={isBundlesActive}
                  render={
                    <Link
                      to="/"
                      search={{
                        afterReleaseId: undefined,
                        beforeReleaseId: undefined,
                        channelId: undefined,
                        enabled: undefined,
                        releaseId: undefined,
                        platform: undefined,
                        targetAppVersion: undefined,
                        bundleId: undefined,
                        page: undefined,
                      }}
                    />
                  }
                  tooltip="Bundles"
                >
                  <Package />
                  <span>Bundles</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
              {analyticsCapability.status === "supported" ? (
                <SidebarMenuItem>
                  <SidebarMenuButton
                    isActive={isAnalyticsActive}
                    render={<Link to="/analytics" />}
                    tooltip="Analytics"
                  >
                    <ChartNoAxesCombined />
                    <span>Analytics</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ) : null}
              {accessKeyCapability.data?.accessKeys ? (
                <SidebarMenuItem>
                  <SidebarMenuButton
                    isActive={isAccessKeysActive}
                    render={<Link to="/access-keys" />}
                    tooltip="Access keys"
                  >
                    <KeyRound />
                    <span>Access keys</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ) : null}
              <SidebarMenuItem>
                <SidebarMenuButton
                  isActive={isSigningActive}
                  render={<Link to="/signing" />}
                  tooltip="Bundle signing"
                >
                  <ShieldCheck />
                  <span>Bundle signing</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
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
