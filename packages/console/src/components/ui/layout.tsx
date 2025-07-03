import logo from "@/assets/logo.png";
import { NativeBuilds } from "@/routes/_components/native-builds";
import type { JSX } from "solid-js";
import { Show, createSignal } from "solid-js";

type TabType = "ota-updates" | "native-builds";

export default function Layout({ children }: { children: JSX.Element }) {
  const [activeTab, setActiveTab] = createSignal<TabType>("ota-updates");

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
              <button
                onClick={() => setActiveTab("ota-updates")}
                class={`w-full text-left px-3 py-2 rounded-md transition-colors ${
                  activeTab() === "ota-updates"
                    ? "bg-blue-100 text-blue-700 font-medium"
                    : "text-gray-700 hover:bg-gray-100"
                }`}
              >
                OTA Updates
              </button>
            </li>
            <li>
              <button
                onClick={() => setActiveTab("native-builds")}
                class={`w-full text-left px-3 py-2 rounded-md transition-colors ${
                  activeTab() === "native-builds"
                    ? "bg-blue-100 text-blue-700 font-medium"
                    : "text-gray-700 hover:bg-gray-100"
                }`}
              >
                Native Builds
              </button>
            </li>
          </ul>
        </nav>
      </div>

      {/* Main Content */}
      <main class="flex-1 p-6 overflow-auto">
        <Show when={activeTab() === "ota-updates"}>
          <div>
            <h1 class="text-2xl font-bold mb-4 tracking-tight">OTA Updates</h1>
            {children}
          </div>
        </Show>
        <Show when={activeTab() === "native-builds"}>
          <NativeBuilds />
        </Show>
      </main>
    </div>
  );
}
