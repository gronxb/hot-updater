import { MetaProvider, Title } from "@solidjs/meta";
import { Route, Router } from "@solidjs/router";
import "./App.css";
import Layout from "@/components/ui/layout";
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query";
import { Toaster } from "./components/ui/toast";
import Home from "./routes";

const queryClient = new QueryClient();

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <Router
        root={(props) => (
          <MetaProvider>
            <Title>HotUpdater Console</Title>
            <Layout>{props.children}</Layout>
          </MetaProvider>
        )}
      >
        <Route path="/" component={Home} />
      </Router>

      <Toaster />
    </QueryClientProvider>
  );
}
