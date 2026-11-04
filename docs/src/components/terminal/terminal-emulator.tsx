"use client";
import "@wterm/dom/src/terminal.css";
import type { WTerm } from "@wterm/dom";
import { useEffect, useRef } from "react";

import type { TerminalEmulatorProps } from "./types";

const ROWS = 20;
const COMPACT_WIDTH = 400;

// The height is fixed in CSS before the terminal loads, so the hero never
// shifts. Rows are a whole number of pixels so every frame lands on the
// same pixel grid.
const STYLES = `
  .demo-terminal-frame {
    container-type: inline-size;
  }
  .demo-terminal.wterm {
    --term-font-family: "Geist Mono", monospace;
    --term-font-size: 13px;
    --term-row-height: 18px;
    --term-bg: transparent;
    --term-fg: #e4e4e7;
    --term-cursor: #f97316;
    --term-color-0: #2e3436;
    --term-color-1: #cc0000;
    --term-color-2: #4e9a06;
    --term-color-3: #c4a000;
    --term-color-4: #3465a4;
    --term-color-5: #75507b;
    --term-color-6: #06989a;
    --term-color-7: #d3d7cf;
    --term-color-8: #555753;
    --term-color-9: #ef2929;
    --term-color-10: #8ae234;
    --term-color-11: #fce94f;
    --term-color-12: #729fcf;
    --term-color-13: #ad7fa8;
    --term-color-14: #34e2e2;
    --term-color-15: #eeeeec;
    height: calc(${ROWS} * var(--term-row-height));
    padding: 0;
    border-radius: 0;
    box-shadow: none;
    scrollbar-width: none;
  }
  .demo-terminal.wterm::-webkit-scrollbar {
    display: none;
  }
  /* The demo takes no input. wterm moves its input textarea with the cursor,
     which records a layout shift on every typed character, and a tap on it
     would open the keyboard on a phone. */
  .demo-terminal.wterm textarea {
    display: none;
  }
  @container (max-width: ${COMPACT_WIDTH}px) {
    .demo-terminal.wterm {
      --term-font-size: 11px;
      --term-row-height: 14px;
    }
  }
`;

export function TerminalEmulator({ onReady }: TerminalEmulatorProps) {
  const frameRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;

    // wterm reads the row height once, when a terminal starts, so crossing
    // the compact breakpoint starts a new terminal.
    let compact: boolean | undefined;
    let stop: (() => void) | undefined;
    const observer = new ResizeObserver(([entry]) => {
      const next = entry!.contentRect.width <= COMPACT_WIDTH;
      if (next === compact) return;
      compact = next;
      stop?.();
      stop = startTerminal(frame, onReady);
    });
    observer.observe(frame);

    return () => {
      observer.disconnect();
      stop?.();
    };
  }, [onReady]);

  return (
    <>
      <style>{STYLES}</style>
      <div ref={frameRef} className="demo-terminal-frame" />
    </>
  );
}

function startTerminal(
  frame: HTMLElement,
  onReady: TerminalEmulatorProps["onReady"],
): () => void {
  const element = document.createElement("div");
  element.className = "wterm demo-terminal";
  element.tabIndex = -1;
  frame.replaceChildren(element);

  const controller = new AbortController();
  let term: WTerm | undefined;

  const init = async () => {
    // Load the font first: a late font swap would change the cell width,
    // and the grid would reflow in the middle of the animation.
    const [{ WTerm }] = await Promise.all([
      import("@wterm/dom"),
      // A failed font load falls back to monospace instead of no demo.
      document.fonts.load('13px "Geist Mono"').catch(() => []),
    ]);
    if (controller.signal.aborted) return;

    term = new WTerm(element, {
      rows: ROWS,
      cursorBlink: false,
      // A demo takes no input; without onData, keys would echo.
      onData: () => {},
    });
    const focused = document.activeElement;
    await term.init();
    // init() focuses the terminal input; a page load must not move focus.
    const active = document.activeElement;
    if (active instanceof HTMLElement && element.contains(active)) {
      if (focused instanceof HTMLElement && focused !== document.body) {
        focused.focus({ preventScroll: true });
      } else {
        active.blur();
      }
    }
    if (controller.signal.aborted) return;
    await onReady?.(term, controller.signal);
  };
  void init().catch((error) => {
    if (!controller.signal.aborted) console.error(error);
  });

  return () => {
    controller.abort();
    term?.destroy();
    element.remove();
  };
}
