import "./app.css";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fetch } from "@tauri-apps/plugin-http";
import { httpBatchLink } from "@trpc/react-query";
import { OverlayProvider } from "overlay-kit";
import { Route, Switch } from "wouter";
import { Header } from "./components/header";
import { ThemeProvider } from "./components/theme-provider";
import { Toaster } from "./components/ui/toaster";
import { trpc } from "./lib/trpc";
import { EmptyConfigPage } from "./pages/empty-config";
import { HomePage } from "./pages/home";

const queryClient = new QueryClient();
const trpcClient = trpc.createClient({
  links: [
    httpBatchLink({
      fetch,
      url: "http://localhost:1422/trpc",
    }),
  ],
});

export default function App() {
  return (
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <OverlayProvider>
          <ThemeProvider defaultTheme="dark" storageKey="vite-ui-theme">
            <Header />

            <Switch>
              <Route path="/" component={HomePage} />
              <Route path="/empty-config" component={EmptyConfigPage} />

              {/* Default route in a switch */}
              <Route>404: No such page!</Route>
            </Switch>
            <Toaster />
          </ThemeProvider>
        </OverlayProvider>
      </QueryClientProvider>
    </trpc.Provider>
  );
}
