import { Link, useRouterState } from "@tanstack/react-router";
import { Package, BarChart3, Moon, Sun } from "lucide-react";
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
  SidebarSeparator,
} from "@/components/ui/sidebar";

export function AppSidebar() {
  const { theme, setTheme } = useTheme();
  const routerState = useRouterState();
  const currentPath = routerState.location.pathname;

  const isBundlesActive = currentPath === "/";
  const isAnalyticsActive = currentPath.startsWith("/analytics");

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader className="p-4">
        <Link
          to="/"
          search={{
            channel: undefined,
            platform: undefined,
            offset: undefined,
          }}
          className="flex items-center gap-3"
        >
          <HotUpdaterLogo className="h-8 w-8 shrink-0" />
          <div className="flex flex-col group-data-[collapsible=icon]:hidden">
            <span className="text-sm font-semibold tracking-tight text-sidebar-foreground">
              Hot Updater
            </span>
            <span className="text-[10px] text-sidebar-foreground/60">
              Console
            </span>
          </div>
        </Link>
      </SidebarHeader>

      <SidebarSeparator />

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
                      offset: undefined,
                    }}
                  >
                    <Package />
                    <span>Bundles</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton
                  asChild
                  isActive={isAnalyticsActive}
                  tooltip="Analytics"
                >
                  <Link
                    to="/analytics"
                    search={{
                      bundleId: undefined,
                      platform: undefined,
                      channel: undefined,
                    }}
                  >
                    <BarChart3 />
                    <span>Analytics</span>
                  </Link>
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
