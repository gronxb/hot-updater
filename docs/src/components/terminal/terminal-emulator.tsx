"use client";
import type { Terminal } from "@xterm/xterm";
import { useEffect, useRef, useState } from "react";
import type { TerminalEmulatorProps } from "./types";

const DEFAULT_THEME = {
  background: "#0a0a0a",
  foreground: "#e4e4e7",
  cursor: "#f97316",
  selectionBackground: "#3f3f46",
};

const getResponsiveConfig = (width: number) => {
  // Mobile
  if (width < 640) {
    return {
      fontSize: 9,
      rows: 15,
      cols: 35,
    };
  }
  // Tablet
  if (width < 1024) {
    return {
      fontSize: 11,
      rows: 18,
      cols: 50,
    };
  }
  // Desktop
  return {
    fontSize: 13,
    rows: 20,
    cols: 70,
  };
};

export function TerminalEmulator({ config, onReady }: TerminalEmulatorProps) {
  const terminalRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<Terminal | null>(null);
  const isInitializedRef = useRef(false);
  const [windowWidth, setWindowWidth] = useState(
    typeof window !== "undefined" ? window.innerWidth : 1024,
  );

  // Handle window resize
  useEffect(() => {
    if (typeof window === "undefined") return;

    const handleResize = () => {
      setWindowWidth(window.innerWidth);
    };

    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  // Update terminal size on window resize
  useEffect(() => {
    if (!xtermRef.current) return;

    const responsiveConfig = getResponsiveConfig(windowWidth);
    xtermRef.current.resize(responsiveConfig.cols, responsiveConfig.rows);
  }, [windowWidth]);

  useEffect(() => {
    if (!terminalRef.current || typeof window === "undefined") return;

    // Prevent duplicate terminal instances
    if (isInitializedRef.current || xtermRef.current) return;

    isInitializedRef.current = true;

    // Dynamically import xterm only on client side
    let term: Terminal | null = null;

    (async () => {
      const { Terminal } = await import("@xterm/xterm");
      await import("@xterm/xterm/css/xterm.css");

      if (!terminalRef.current || xtermRef.current) return;

      const responsiveConfig = getResponsiveConfig(windowWidth);

      term = new Terminal({
        cursorBlink: true,
        fontFamily: "Geist Mono, monospace",
        ...responsiveConfig,
        ...config,
        theme: {
          ...DEFAULT_THEME,
          ...config?.theme,
        },
      });

      term.open(terminalRef.current);
      xtermRef.current = term;

      if (onReady) {
        onReady(term);
      }
    })();

    return () => {
      isInitializedRef.current = false;
      if (term) {
        term.dispose();
      }
      if (xtermRef.current) {
        xtermRef.current.dispose();
        xtermRef.current = null;
      }
    };
  }, [config, onReady, windowWidth]);

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
