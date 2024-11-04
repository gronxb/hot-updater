import { MetaProvider, Title } from "@solidjs/meta";
import { Route, Router } from "@solidjs/router";
import { Suspense } from "solid-js";
import "./App.css";
import { Toaster } from "./components/ui/sonner";
import Home from "./routes";

export default function App() {
  return (
    <Router
      root={(props) => (
        <MetaProvider>
          <Title>HotUpdater Console</Title>
          <Suspense>{props.children}</Suspense>
          <Toaster />
        </MetaProvider>
      )}
    >
      <Route path="/" component={Home} />
    </Router>
  );
}
