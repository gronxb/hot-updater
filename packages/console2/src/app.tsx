import { MetaProvider, Title } from "@solidjs/meta";
import { Router } from "@solidjs/router";
import { FileRoutes } from "@solidjs/start/router";
import { Suspense } from "solid-js";
import "./app.css";
import { Toaster } from "./components/ui/sonner";

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
      <FileRoutes />
    </Router>
  );
}
