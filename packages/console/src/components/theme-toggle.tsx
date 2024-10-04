import { Button } from "@/components/ui/button";
import { Moon, Sun } from "lucide-react";
import { useTheme } from "./theme-provider";

export interface ThemeToggleProps {
  class?: string;
}

export const ThemeToggle = (props: ThemeToggleProps) => {
  const { theme, setTheme } = useTheme();

  const toggleColorMode = () => {
    setTheme(theme === "dark" ? "light" : "dark");
  };

  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={toggleColorMode}
      className={props.class}
    >
      <Sun className="h-[1.5rem] w-[1.3rem] dark:hidden transition duration-300 ease-in-out" />
      <Moon className="hidden w-5 h-5 transition duration-300 ease-in-out dark:block" />
    </Button>
  );
};
