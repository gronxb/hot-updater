import type { Terminal } from "@xterm/xterm";

export interface TerminalConfig {
  cursorBlink?: boolean;
  fontSize?: number;
  fontFamily?: string;
  theme?: {
    background?: string;
    foreground?: string;
    cursor?: string;
    selectionBackground?: string;
  };
  rows?: number;
  cols?: number;
}

export interface TerminalEmulatorProps {
  config?: TerminalConfig;
  onReady?: (terminal: Terminal) => void;
}

export interface ClackRendererProps {
  terminal: Terminal;
}

export interface DemoConfig {
  platform: string;
  channel: string;
  fingerprint: string;
  plugins: {
    build: string;
    storage: string;
    database: string;
  };
}
