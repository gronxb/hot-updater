import { createContext, useContext, useEffect, useState } from "react";

type Theme = "dark" | "light" | "system";

interface ThemeContextType {
  theme: Theme;
  setTheme: (theme: Theme) => void;
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);
const LIGHT_THEME_COLOR = "#fbfbfa";
const DARK_THEME_COLOR = "#1f1d1c";
const REFRESH_THEME_CHROME_EVENT = "hot-updater:refresh-theme-chrome";

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
    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const themeColorMeta = window.document.querySelector(
      'meta[name="theme-color"]',
    );
    const colorSchemeMeta = window.document.querySelector(
      'meta[name="color-scheme"]',
    );

    const applyResolvedTheme = (resolvedTheme: "dark" | "light") => {
      root.classList.remove("light", "dark");
      root.classList.add(resolvedTheme);
      root.style.colorScheme = resolvedTheme;

      if (themeColorMeta) {
        themeColorMeta.setAttribute(
          "content",
          resolvedTheme === "dark" ? DARK_THEME_COLOR : LIGHT_THEME_COLOR,
        );
      }

      if (colorSchemeMeta) {
        colorSchemeMeta.setAttribute(
          "content",
          resolvedTheme === "dark" ? "dark light" : "light dark",
        );
      }
    };

    const syncTheme = () => {
      const resolvedTheme =
        theme === "system" ? (mediaQuery.matches ? "dark" : "light") : theme;

      applyResolvedTheme(resolvedTheme);
    };

    syncTheme();

    const refreshThemeChrome = () => {
      window.requestAnimationFrame(syncTheme);
    };

    window.addEventListener(REFRESH_THEME_CHROME_EVENT, refreshThemeChrome);
    window.addEventListener("pageshow", refreshThemeChrome);
    document.addEventListener("visibilitychange", refreshThemeChrome);

    if (theme === "system") {
      mediaQuery.addEventListener("change", syncTheme);
    }

    return () => {
      if (theme === "system") {
        mediaQuery.removeEventListener("change", syncTheme);
      }
      window.removeEventListener(
        REFRESH_THEME_CHROME_EVENT,
        refreshThemeChrome,
      );
      window.removeEventListener("pageshow", refreshThemeChrome);
      document.removeEventListener("visibilitychange", refreshThemeChrome);
    };
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
