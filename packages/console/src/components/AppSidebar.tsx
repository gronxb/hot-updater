import { Link, useRouterState } from "@tanstack/react-router";
import {
  ChartNoAxesCombined,
  KeyRound,
  LogOut,
  Moon,
  Package,
  ShieldCheck,
  Sun,
} from "lucide-react";
import { useState } from "react";
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
} from "@/components/ui/sidebar";
import { useApiKeyCapabilityQuery } from "@/lib/api-keys-api";

export function AppSidebar({ canSignOut = false }: { canSignOut?: boolean }) {
  const [signingOut, setSigningOut] = useState(false);
  const apiKeyCapability = useApiKeyCapabilityQuery();
  const { theme, setTheme } = useTheme();
  const routerState = useRouterState();
  const currentPath = routerState.location.pathname;

  const isBundlesActive = currentPath === "/";
  const isInsightsActive =
    currentPath === "/insights" ||
    currentPath === "/insights/distribution" ||
    currentPath === "/installations";
  const isApiKeysActive = currentPath === "/api-keys";
  const isSigningActive = currentPath === "/signing";

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
              <SidebarMenuItem>
                <SidebarMenuButton
                  isActive={isInsightsActive}
                  render={<Link to="/insights" />}
                  tooltip="Insights"
                >
                  <ChartNoAxesCombined />
                  <span>Insights</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
              {apiKeyCapability.data?.apiKeys ? (
                <SidebarMenuItem>
                  <SidebarMenuButton
                    isActive={isApiKeysActive}
                    render={<Link to="/api-keys" />}
                    tooltip="API keys"
                  >
                    <KeyRound />
                    <span>API keys</span>
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
