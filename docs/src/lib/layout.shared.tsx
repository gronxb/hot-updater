import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";
import { Github } from "lucide-react";

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: (
        <div className="flex items-center gap-1">
          <img
            src="/logo.webp"
            alt="Hot Updater"
            className="w-6 h-6 object-contain shrink-0 mt-1.25"
            loading="eager"
            fetchpriority="high"
            decoding="sync"
          />
          <span>Hot Updater</span>
        </div>
      ),
    },
    links: [
      {
        text: "Docs",
        url: "/docs/get-started/introduction",
      },
      {
        text: "GitHub",
        url: "https://github.com/gronxb/hot-updater",
        external: true,
        icon: <Github />,
      },
    ],
  };
}
