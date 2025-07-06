import logo from "@/assets/logo.png";
import { useLocation } from "@solidjs/router";
import { A } from "@solidjs/router";
import type { JSX } from "solid-js";

export default function Layout({ children }: { children: JSX.Element }) {
  const location = useLocation();

  const isActive = (path: string) => {
    if (path === "/ota-updates") {
      return location.pathname === "/" || location.pathname === "/ota-updates";
    }
    return location.pathname === path;
  };

  return (
    <div class="flex h-screen">
      {/* Sidebar */}
      <div class="w-64 bg-gray-50 border-r border-gray-200 flex flex-col">
        {/* Header */}
        <div class="p-4 border-b border-gray-200">
          <div class="flex flex-row items-center gap-2">
            <img src={logo} alt="Hot Updater Console" class="w-8 h-8" />
            <a
              href="https://github.com/gronxb/hot-updater"
              target="_blank"
              class="text-lg font-light"
              rel="noreferrer"
            >
              Hot Updater Console
            </a>
          </div>
        </div>

        {/* Navigation */}
        <nav class="flex-1 p-4">
          <ul class="space-y-2">
            <li>
              <A
                href="/ota-updates"
                class={`block w-full text-left px-3 py-2 rounded-md transition-colors ${
                  isActive("/ota-updates")
                    ? "bg-blue-100 text-blue-700 font-medium"
                    : "text-gray-700 hover:bg-gray-100"
                }`}
              >
                OTA Updates
              </A>
            </li>
            <li>
              <A
                href="/native-builds"
                class={`block w-full text-left px-3 py-2 rounded-md transition-colors ${
                  isActive("/native-builds")
                    ? "bg-blue-100 text-blue-700 font-medium"
                    : "text-gray-700 hover:bg-gray-100"
                }`}
              >
                Native Builds
              </A>
            </li>
          </ul>
        </nav>
      </div>

      {/* Main Content */}
      <main class="flex-1 p-6 overflow-auto">{children}</main>
    </div>
  );
}
