"use client";
import "@xterm/xterm/css/xterm.css";
import type { Terminal } from "@xterm/xterm";
import { useEffect, useRef } from "react";

import type { TerminalEmulatorProps } from "./types";

const DEFAULT_THEME = {
  background: "#0a0a0a",
  foreground: "#e4e4e7",
  cursor: "#f97316",
  selectionBackground: "#3f3f46",
};

export function TerminalEmulator({ config, onReady }: TerminalEmulatorProps) {
  const terminalRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = terminalRef.current;
    if (!container) return;

    const controller = new AbortController();
    let term: Terminal | undefined;
    let observer: ResizeObserver | undefined;
    let resizeFrame = 0;
    const context = document.createElement("canvas").getContext("2d")!;

    const fit = () => {
      if (!term || controller.signal.aborted || !container.clientWidth) return;
      const fontSize =
        config?.fontSize ?? (container.clientWidth < 400 ? 11 : 13);
      const fontFamily = config?.fontFamily ?? "Geist Mono, monospace";
      context.font = `${fontSize}px ${fontFamily}`;
      const cellWidth = context.measureText("W").width;
      const cols = Math.max(
        1,
        Math.floor((container.clientWidth - 2) / cellWidth),
      );
      term.options.fontSize = fontSize;
      term.resize(Math.min(config?.cols ?? cols, cols), config?.rows ?? 20);
      term.scrollToBottom();
    };

    const init = async () => {
      const [{ Terminal }] = await Promise.all([
        import("@xterm/xterm"),
        document.fonts.ready,
      ]);
      if (controller.signal.aborted) return;

      term = new Terminal({
        cursorBlink: false,
        convertEol: true,
        disableStdin: true,
        fontFamily: "Geist Mono, monospace",
        fontSize: 13,
        lineHeight: 1.2,
        rows: 20,
        cols: 50,
        ...config,
        theme: { ...DEFAULT_THEME, ...config?.theme },
      });
      term.open(container);
      fit();
      observer = new ResizeObserver(() => {
        cancelAnimationFrame(resizeFrame);
        resizeFrame = requestAnimationFrame(fit);
      });
      observer.observe(container);
      await onReady?.(term, controller.signal);
    };
    void init().catch((error) => {
      if (!controller.signal.aborted) console.error(error);
    });

    return () => {
      controller.abort();
      observer?.disconnect();
      cancelAnimationFrame(resizeFrame);
      term?.dispose();
    };
  }, [config, onReady]);

  return (
    <>
      <style>
        {`
          .xterm-viewport::-webkit-scrollbar {
            display: none;
          }
          .xterm-viewport {
            -ms-overflow-style: none;
            scrollbar-width: none;
          }
        `}
      </style>
      <div ref={terminalRef} className="w-full overflow-hidden" />
    </>
  );
}
