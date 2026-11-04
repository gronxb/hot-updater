/** The part of the terminal a scripted demo drives. */
export interface DemoTerminal {
  readonly cols: number;
  write(data: string): void;
}

export interface TerminalEmulatorProps {
  onReady?: (
    terminal: DemoTerminal,
    signal: AbortSignal,
  ) => void | Promise<void>;
}

export interface DemoConfig {
  platform: string;
  channel: string;
  appVersion: string;
  plugins: {
    build: string;
    storage: string;
    database: string;
  };
}
