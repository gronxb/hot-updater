import { MetaProvider, Title } from "@solidjs/meta";
import { Route, Router } from "@solidjs/router";
import "./App.css";
import { SplashScreen } from "@/components/spash-screen";
import Layout from "@/components/ui/layout";
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query";
import { Suspense } from "solid-js";
import Home from "./routes";

const queryClient = new QueryClient();

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <Router
        root={(props) => (
          <MetaProvider>
            <Title>HotUpdater Console</Title>
            <Suspense fallback={<SplashScreen />}>
              <Layout>{props.children}</Layout>
            </Suspense>
          </MetaProvider>
        )}
      >
        <Route path="/" component={Home} />
        <Route path="/:bundleId" component={Home} />
      </Router>
    </QueryClientProvider>
  );
}
