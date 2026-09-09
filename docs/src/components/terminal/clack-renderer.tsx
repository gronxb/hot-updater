import type { Terminal } from "@xterm/xterm";

const S_BAR = "\x1b[90m│\x1b[0m";
const S_BAR_END = "\x1b[90m└\x1b[0m";
const S_STEP_SUBMIT = "\x1b[32m◇\x1b[0m";

const cyan = (text: string) => `\x1b[36m${text}\x1b[0m`;
const gray = (text: string) => `\x1b[90m${text}\x1b[0m`;
const green = (text: string) => `\x1b[32m${text}\x1b[0m`;
const blue = (text: string) => `\x1b[34m${text}\x1b[0m`;
const magenta = (text: string) => `\x1b[35m${text}\x1b[0m`;
const yellow = (text: string) => `\x1b[33m${text}\x1b[0m`;

export class ClackRenderer {
  constructor(
    private terminal: Terminal,
    private signal?: AbortSignal,
  ) {}

  write(text: string): void {
    if (!this.signal?.aborted) {
      this.terminal.write(text.replace(/\r?\n/g, "\r\n"));
    }
  }

  async pause(ms: number): Promise<void> {
    if (this.signal?.aborted) return;
    await new Promise<void>((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        this.signal?.removeEventListener("abort", finish);
        resolve();
      };
      const timer = setTimeout(finish, ms);
      this.signal?.addEventListener("abort", finish, { once: true });
    });
  }

  async typeText(text: string, color = "\x1b[0m"): Promise<void> {
    for (const char of text) {
      if (this.signal?.aborted) return;
      this.write(color + char);
      await this.pause(25);
    }
    this.write("\x1b[0m");
  }

  note(title: string, lines: string[]): void {
    this.write(`${S_BAR}\n${S_STEP_SUBMIT}  ${title}\n`);
    for (const line of lines) this.write(`${S_BAR}  ${line}\n`);
  }

  async task(text: string, completed: string, duration: number): Promise<void> {
    const frames = ["◒", "◐", "◓", "◑"] as const;
    const startTime = Date.now();
    let frameIndex = 0;
    this.write(`${S_BAR}\n`);
    while (Date.now() - startTime < duration && !this.signal?.aborted) {
      const available = Math.max(1, this.terminal.cols - 3);
      const label =
        text.length > available ? `${text.slice(0, available - 1)}…` : text;
      const frame = frames[frameIndex++ % frames.length]!;
      this.write(`\r\x1b[K${magenta(frame)}  ${label}`);
      await this.pause(80);
    }
    this.write(`\r\x1b[K${S_STEP_SUBMIT}  ${completed}\n`);
  }

  outro(message: string): void {
    this.write(`${S_BAR}\n${S_BAR_END}  ${message}\n`);
  }

  async finish(): Promise<void> {
    if (this.signal?.aborted) return;
    await new Promise<void>((resolve) => {
      this.terminal.write("\r\n\x1b[0m$ ", () => {
        this.terminal.scrollToBottom();
        resolve();
      });
    });
  }
}

export { blue, cyan, gray, green, magenta, yellow };
