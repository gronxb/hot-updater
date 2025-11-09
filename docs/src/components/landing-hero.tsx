"use client";
import { Github } from "lucide-react";
import { Link } from "waku";
import { runDeployDemo } from "./terminal/deploy-demo";
import { TerminalEmulator } from "./terminal/terminal-emulator";

export function LandingHero() {
  return (
    <div className="relative overflow-hidden bg-fd-background">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-20 sm:py-24 lg:py-32">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-10 lg:gap-16 items-center">
          {/* Left side - Content */}
          <div className="space-y-8 sm:space-y-8">
            {/* Title */}
            <div className="space-y-3 sm:space-y-4">
              <h1 className="text-4xl sm:text-5xl lg:text-6xl xl:text-7xl font-bold tracking-tight">
                <div className="flex items-center gap-4">
                  <img
                    src="/logo.webp"
                    alt="Hot Updater Logo"
                    className="h-10 mt-3.5 sm:h-14 lg:h-16 xl:h-20 object-contain shrink-0"
                    loading="eager"
                    fetchPriority="high"
                    decoding="sync"
                  />
                  <span className="bg-linear-to-r from-orange-400 via-orange-400 to-orange-500 bg-clip-text text-transparent">
                    Hot Updater
                  </span>
                </div>
              </h1>
              <p className="text-lg sm:text-xl lg:text-2xl text-fd-muted-foreground max-w-xl">
                Self-hosted over-the-air updates for React Native
              </p>
            </div>

            {/* Install command */}
            <div className="relative w-full max-w-md">
              <div className="relative rounded-lg border border-fd-border bg-fd-card/80 backdrop-blur-sm px-3 sm:px-4 py-2.5 sm:py-3 shadow-lg space-y-2">
                <div className="flex items-center gap-2 sm:gap-3">
                  <span className="text-orange-500 text-xs sm:text-sm font-mono select-none shrink-0">
                    $
                  </span>
                  <code className="text-xs sm:text-sm font-mono text-fd-foreground flex-1 overflow-x-auto">
                    npm i hot-updater --save-dev
                  </code>
                </div>
                <div className="flex items-center gap-2 sm:gap-3">
                  <span className="text-orange-500 text-xs sm:text-sm font-mono select-none shrink-0">
                    $
                  </span>
                  <code className="text-xs sm:text-sm font-mono text-fd-foreground flex-1 overflow-x-auto">
                    npx hot-updater init
                  </code>
                </div>
              </div>
            </div>

            {/* CTA buttons */}
            <div className="flex flex-wrap items-center gap-3 sm:gap-4">
              <Link
                to="/docs/get-started/introduction"
                className="inline-flex items-center justify-center rounded-lg bg-linear-to-r from-orange-400 to-orange-500 px-5 sm:px-6 py-2.5 sm:py-3 text-sm font-semibold text-white shadow-lg transition-all hover:shadow-orange-500/30 hover:scale-105"
              >
                Get Started →
              </Link>
              <a
                href="https://github.com/gronxb/hot-updater"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center justify-center gap-2 rounded-lg border border-fd-border bg-fd-card/50 px-5 sm:px-6 py-2.5 sm:py-3 text-sm font-semibold text-fd-foreground backdrop-blur-sm transition-all hover:bg-fd-accent/50 hover:border-fd-border/70"
              >
                <Github className="w-4 h-4" />
                GitHub
              </a>
            </div>
          </div>

          {/* Right side - Terminal Demo */}
          <div className="relative mt-8 lg:mt-0">
            <div className="absolute -inset-2 sm:-inset-4 bg-linear-to-r from-orange-500/20 to-red-600/20 rounded-2xl blur-2xl opacity-50 sm:opacity-100" />
            <div className="relative rounded-xl border border-zinc-800 bg-zinc-950/95 backdrop-blur-xl shadow-2xl overflow-hidden">
              {/* Terminal header */}
              <div className="flex items-center gap-2 px-3 sm:px-4 py-2 sm:py-3 border-b border-zinc-800 bg-zinc-900/80">
                <div className="flex gap-1.5">
                  <div className="w-2.5 h-2.5 sm:w-3 sm:h-3 rounded-full bg-red-500/80" />
                  <div className="w-2.5 h-2.5 sm:w-3 sm:h-3 rounded-full bg-yellow-500/80" />
                  <div className="w-2.5 h-2.5 sm:w-3 sm:h-3 rounded-full bg-green-500/80" />
                </div>
                <span className="ml-2 text-[10px] sm:text-xs text-zinc-500 font-mono">
                  terminal
                </span>
              </div>

              {/* XTerm Terminal */}
              <div className="p-2 sm:p-4 min-h-[190px] sm:min-h-[258px] lg:min-h-[333px]">
                <TerminalEmulator onReady={runDeployDemo} />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
