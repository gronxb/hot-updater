import { Button } from "@/components/ui/button";
import { useColorMode } from "@kobalte/core";
import { Moon, Sun } from "lucide-solid";

export interface ThemeToggleProps {
  class?: string;
}

export const ThemeToggle = (props: ThemeToggleProps) => {
  const { toggleColorMode } = useColorMode();

  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={toggleColorMode}
      class={props.class}
    >
      <Sun class="h-[1.5rem] w-[1.3rem] dark:hidden transition duration-300 ease-in-out" />
      <Moon class="hidden w-5 h-5 dark:block transition duration-300 ease-in-out" />
    </Button>
  );
};
