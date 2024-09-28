import { ColorModeProvider, ColorModeScript } from "@kobalte/core";
import { MetaProvider } from "@solidjs/meta";
import { Route, Router } from "@solidjs/router";
import { Suspense } from "solid-js";
import { Home } from "./routes/home";
import "./app.css";
import { ThemeToggle } from "./components/theme-toggle";
import { ToastList, ToastRegion } from "./components/ui/toast";

export default function App() {
  return (
    <Router
      root={(props) => (
        <MetaProvider>
          <Suspense>
            <ColorModeScript />
            <ColorModeProvider>
              <header class="header h-10 flex justify-between items-center w-full">
                <div class="flex-1" />
                <ThemeToggle class="pointer-events-auto header-no-drag" />
              </header>
              {props.children}
            </ColorModeProvider>
            <ToastRegion>
              <ToastList />
            </ToastRegion>
          </Suspense>
        </MetaProvider>
      )}
    >
      <Route path="/" component={Home} />
    </Router>
  );
}
