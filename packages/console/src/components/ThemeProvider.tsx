import { createContext, useContext, useEffect, useState } from "react";

type Theme = "dark" | "light" | "system";

interface ThemeContextType {
  theme: Theme;
  setTheme: (theme: Theme) => void;
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);
const LIGHT_THEME_COLOR = "#fbfbfa";
const DARK_THEME_COLOR = "#242221";

export function ThemeProvider({
  children,
  defaultTheme = "dark",
  storageKey = "hot-updater-theme",
}: {
  children: React.ReactNode;
  defaultTheme?: Theme;
  storageKey?: string;
}) {
  const [theme, setTheme] = useState<Theme>(defaultTheme);

  useEffect(() => {
    const stored = localStorage.getItem(storageKey) as Theme | null;
    if (stored) {
      setTheme(stored);
    }
  }, [storageKey]);

  useEffect(() => {
    const root = window.document.documentElement;
    root.classList.remove("light", "dark");

    const resolvedTheme =
      theme === "system"
        ? window.matchMedia("(prefers-color-scheme: dark)").matches
          ? "dark"
          : "light"
        : theme;

    root.style.colorScheme = resolvedTheme;

    const themeColorMeta = window.document.querySelector(
      'meta[name="theme-color"]:not([media])',
    );
    if (themeColorMeta) {
      themeColorMeta.setAttribute(
        "content",
        resolvedTheme === "dark" ? DARK_THEME_COLOR : LIGHT_THEME_COLOR,
      );
    }

    if (theme === "system") {
      root.classList.add(resolvedTheme);
    } else {
      root.classList.add(theme);
    }
  }, [theme]);

  const value = {
    theme,
    setTheme: (newTheme: Theme) => {
      localStorage.setItem(storageKey, newTheme);
      setTheme(newTheme);
    },
  };

  return (
    <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
  );
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (context === undefined) {
    throw new Error("useTheme must be used within a ThemeProvider");
  }
  return context;
}
