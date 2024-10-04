import { ColorModeProvider, ColorModeScript } from "@kobalte/core";
import { MetaProvider } from "@solidjs/meta";
import { MemoryRouter, Route, createMemoryHistory } from "@solidjs/router";
import { Suspense } from "solid-js";
import { Home } from "./routes/home";
import "./app.css";
import { ThemeToggle } from "./components/theme-toggle";
import { ToastList, ToastRegion } from "./components/ui/toast";
import { EmptyConfig } from "./routes/empty-config";

export default function App() {
  const history = createMemoryHistory();

  return (
    <MemoryRouter
      history={history}
      root={(props) => (
        <MetaProvider>
          <Suspense>
            <ColorModeScript />
            <ColorModeProvider>
              <header
                data-tauri-drag-region
                class="h-10 rounded-full flex justify-between items-center w-full"
              >
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
      <Route path="/empty-config" component={EmptyConfig} />
    </MemoryRouter>
  );
}
