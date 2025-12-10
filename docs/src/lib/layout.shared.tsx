import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";
import { Github } from "lucide-react";
import { Logo } from "../components/Logo";

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: (
        <div className="flex items-center gap-1">
          <Logo className="w-5 h-5 shrink-0" />
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
