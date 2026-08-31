import type { QueryClient } from "@tanstack/react-query";
import {
  createRootRouteWithContext,
  HeadContent,
  Outlet,
  Scripts,
} from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { AppSidebar } from "@/components/AppSidebar";
import { ConsoleAccessPage } from "@/components/ConsoleAccessPage";
import { InsightsCapabilityProvider } from "@/components/features/insights/InsightsCapabilityContext";
import { NotFoundPage } from "@/components/NotFoundPage";
import { ThemeProvider } from "@/components/ThemeProvider";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  getConsoleAccessRpc,
  getConsoleAuthProvidersRpc,
} from "@/lib/auth-rpc";
import {
  getInsightsCapabilityState,
  useInsightsCapabilitiesQuery,
} from "@/lib/insights-api";

import appCss from "../styles.css?url";

const LOCAL_DEBUG_HOSTS = new Set(["127.0.0.1", "localhost"]);

type LocalDevtools = {
  readonly Devtools: typeof import("@tanstack/react-devtools").TanStackDevtools;
  readonly RouterPanel: typeof import("@tanstack/react-router-devtools").TanStackRouterDevtoolsPanel;
};

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
        content: "width=device-width, initial-scale=1, viewport-fit=cover",
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

  loader: async () => {
    const [access, providers] = await Promise.all([
      getConsoleAccessRpc(),
      getConsoleAuthProvidersRpc(),
    ]);
    return { access, providers };
  },

  component: RootLayout,
  notFoundComponent: NotFoundPage,
  shellComponent: RootDocument,
});

export function RootDocument({ children }: { children: React.ReactNode }) {
  const [localDevtools, setLocalDevtools] = useState<LocalDevtools | null>(
    null,
  );

  useEffect(() => {
    if (!import.meta.env.DEV || typeof window === "undefined") {
      return;
    }

    if (LOCAL_DEBUG_HOSTS.has(window.location.hostname)) {
      void Promise.all([
        import("@tanstack/react-devtools"),
        import("@tanstack/react-router-devtools"),
        import("react-grab/core"),
      ]).then(
        ([{ TanStackDevtools }, { TanStackRouterDevtoolsPanel }, { init }]) => {
          setLocalDevtools({
            Devtools: TanStackDevtools,
            RouterPanel: TanStackRouterDevtoolsPanel,
          });
          init({
            activationKey: (event) =>
              event.key.toLowerCase() === "c" && event.metaKey,
          });
        },
      );
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
            {localDevtools ? (
              <localDevtools.Devtools
                config={{
                  position: "bottom-right",
                }}
                plugins={[
                  {
                    name: "Tanstack Router",
                    render: <localDevtools.RouterPanel />,
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
  const { access, providers } = Route.useLoaderData();

  if (access.status !== "authorized") {
    return <ConsoleAccessPage access={access} providers={providers} />;
  }

  return <AuthorizedConsole />;
}

function AuthorizedConsole() {
  const capabilityQuery = useInsightsCapabilitiesQuery();
  const capability = getInsightsCapabilityState(capabilityQuery);

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
    <InsightsCapabilityProvider value={capability}>
      <SidebarProvider>
        <AppSidebar />
        <SidebarInset className="min-h-0 min-w-0 overflow-hidden">
          <Outlet />
        </SidebarInset>
      </SidebarProvider>
    </InsightsCapabilityProvider>
  );
}
