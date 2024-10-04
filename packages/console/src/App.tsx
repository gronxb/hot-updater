import "./app.css";
import { Route, Switch } from "wouter";
import { ThemeProvider } from "./components/theme-provider";
import { ThemeToggle } from "./components/theme-toggle";
import { Toaster } from "./components/ui/toaster";
import { EmptyConfigPage } from "./pages/empty-config";
import { HomePage } from "./pages/home";

export default function App() {
  return (
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
  );
}
