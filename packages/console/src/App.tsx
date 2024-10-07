import "./app.css";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fetch } from "@tauri-apps/plugin-http";
import { httpBatchLink } from "@trpc/react-query";
import { Route, Switch } from "wouter";
import { ThemeProvider } from "./components/theme-provider";
import { ThemeToggle } from "./components/theme-toggle";
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
        <ThemeProvider defaultTheme="dark" storageKey="vite-ui-theme">
          <header
            data-tauri-drag-region
            className="h-10 rounded-full flex justify-between items-center w-full"
          >
            <div className="flex-1" />
            <ThemeToggle />
          </header>

          <Switch>
            <Route path="/" component={HomePage} />

            <Route path="/empty-config" component={EmptyConfigPage} />

            {/* Default route in a switch */}
            <Route>404: No such page!</Route>
          </Switch>
          <Toaster />
        </ThemeProvider>
      </QueryClientProvider>
    </trpc.Provider>
  );
}
