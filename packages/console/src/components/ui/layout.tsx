import logo from "@/assets/logo.png";
import type { JSX } from "solid-js";

export default function Layout({ children }: { children: JSX.Element }) {
  return (
    <main class="w-full space-y-2.5">
      <div class="flex flex-row items-center gap-1">
        <img src={logo} alt="Hot Updater Console" class="w-12 h-12" />
        <a
          href="https://github.com/gronxb/hot-updater"
          target="_blank"
          class="text-2xl font-light"
          rel="noreferrer"
        >
          Hot Updater Console
        </a>
      </div>
      {children}
    </main>
  );
}
