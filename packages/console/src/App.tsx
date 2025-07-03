import Layout from "@/components/ui/layout";
import { MetaProvider, Title } from "@solidjs/meta";
import { Route, Router } from "@solidjs/router";
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query";
import "./App.css";
import { Toaster } from "./components/ui/toast";
import Home from "./routes";
import NativeBuildsPage from "./routes/native-builds";

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
        <Route path="/ota-updates" component={Home} />
        <Route path="/native-builds" component={NativeBuildsPage} />
      </Router>

      <Toaster />
    </QueryClientProvider>
  );
}
