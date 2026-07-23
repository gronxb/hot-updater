import { TanStackDevtools } from "@tanstack/react-devtools";
import type { QueryClient } from "@tanstack/react-query";
import {
  createRootRouteWithContext,
  HeadContent,
  Outlet,
  Scripts,
} from "@tanstack/react-router";
import { TanStackRouterDevtoolsPanel } from "@tanstack/react-router-devtools";
import { useEffect, useState } from "react";

import { AppSidebar } from "@/components/AppSidebar";
import { AnalyticsCapabilityProvider } from "@/components/features/analytics/AnalyticsCapabilityContext";
import { NotFoundPage } from "@/components/NotFoundPage";
import { ThemeProvider } from "@/components/ThemeProvider";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  getAnalyticsCapabilityState,
  useAnalyticsCapabilitiesQuery,
} from "@/lib/analytics-api";

import appCss from "../styles.css?url";

const LOCAL_DEBUG_HOSTS = new Set(["127.0.0.1", "localhost"]);

export const Route = createRootRouteWithContext<{
  readonly queryClient: QueryClient;
}>()({
  head: () => ({
    meta: [
      {
        charSet: "utf-8",
      },
      {
        name: "viewport",
        content:
          "width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover",
      },
      {
        name: "theme-color",
        content: "#1f1d1c",
      },
      {
        name: "color-scheme",
        content: "dark light",
      },
      {
        title: "Hot Updater Console",
      },
    ],
    links: [
      {
        rel: "stylesheet",
        href: appCss,
      },
    ],
  }),

  component: RootLayout,
  notFoundComponent: NotFoundPage,
  shellComponent: RootDocument,
});

function RootDocument({ children }: { children: React.ReactNode }) {
  const [isLocalDebugHost, setIsLocalDebugHost] = useState(false);

  useEffect(() => {
    if (!import.meta.env.DEV || typeof window === "undefined") {
      return;
    }

    const isDebugHost = LOCAL_DEBUG_HOSTS.has(window.location.hostname);
    setIsLocalDebugHost(isDebugHost);

    if (isDebugHost) {
      void import("react-grab/core").then(({ init }) => {
        init({
          activationKey: (event) =>
            event.key.toLowerCase() === "c" && event.metaKey,
        });
      });
    }
  }, []);
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <HeadContent />
      </head>
      <body>
        <ThemeProvider defaultTheme="dark">
          <TooltipProvider>
            {children}
            <Toaster />
            {import.meta.env.DEV && isLocalDebugHost ? (
              <TanStackDevtools
                config={{
                  position: "bottom-right",
                }}
                plugins={[
                  {
                    name: "Tanstack Router",
                    render: <TanStackRouterDevtoolsPanel />,
                  },
                ]}
              />
            ) : null}
          </TooltipProvider>
        </ThemeProvider>
        <Scripts />
      </body>
    </html>
  );
}

function RootLayout() {
  const capabilityQuery = useAnalyticsCapabilitiesQuery();
  const capability = getAnalyticsCapabilityState(capabilityQuery);

  useEffect(() => {
    if (
      import.meta.env.DEV &&
      typeof window !== "undefined" &&
      LOCAL_DEBUG_HOSTS.has(window.location.hostname)
    ) {
      void import("react-grab");
    }
  }, []);
  return (
    <AnalyticsCapabilityProvider value={capability}>
      <SidebarProvider>
        <AppSidebar />
        <SidebarInset className="min-h-0 min-w-0 overflow-hidden">
          <Outlet />
        </SidebarInset>
      </SidebarProvider>
    </AnalyticsCapabilityProvider>
  );
}
