import type { DemoTerminal } from "./types";

const S_BAR = "\x1b[90m│\x1b[0m";
const S_BAR_END = "\x1b[90m└\x1b[0m";
const S_STEP_SUBMIT = "\x1b[32m◇\x1b[0m";

const cyan = (text: string) => `\x1b[36m${text}\x1b[0m`;
const gray = (text: string) => `\x1b[90m${text}\x1b[0m`;
const green = (text: string) => `\x1b[32m${text}\x1b[0m`;
const blue = (text: string) => `\x1b[34m${text}\x1b[0m`;
const magenta = (text: string) => `\x1b[35m${text}\x1b[0m`;
const yellow = (text: string) => `\x1b[33m${text}\x1b[0m`;

// Animations advance on display frames, never on timers. A step is due once
// its interval has nearly elapsed, so it lands on the same frame count every
// time: a 25 ms setTimeout alternated one and two frames at 60 Hz, and the
// typing stuttered.
const CHAR_INTERVAL_MS = 1000 / 30;
const SPINNER_INTERVAL_MS = 80;
const FRAME_SLACK_MS = 4;

export class ClackRenderer {
  constructor(
    private terminal: DemoTerminal,
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

  private frames(step: (now: number) => boolean): Promise<void> {
    return new Promise<void>((resolve) => {
      if (this.signal?.aborted) return resolve();
      let frame = 0;
      const finish = () => {
        cancelAnimationFrame(frame);
        this.signal?.removeEventListener("abort", finish);
        resolve();
      };
      const tick = (now: number) => {
        if (this.signal?.aborted || !step(now)) finish();
        else frame = requestAnimationFrame(tick);
      };
      this.signal?.addEventListener("abort", finish, { once: true });
      frame = requestAnimationFrame(tick);
    });
  }

  async typeText(text: string, color = "\x1b[0m"): Promise<void> {
    const chars = [...text];
    let typed = 0;
    let last = -Infinity;
    await this.frames((now) => {
      if (now - last >= CHAR_INTERVAL_MS - FRAME_SLACK_MS) {
        last = now;
        this.write(color + chars[typed++]);
      }
      return typed < chars.length;
    });
    this.write("\x1b[0m");
  }

  note(title: string, lines: string[]): void {
    this.write(`${S_BAR}\n${S_STEP_SUBMIT}  ${title}\n`);
    for (const line of lines) this.write(`${S_BAR}  ${line}\n`);
  }

  async task(text: string, completed: string, duration: number): Promise<void> {
    const frames = ["◒", "◐", "◓", "◑"] as const;
    let start: number | undefined;
    let last = -Infinity;
    let frameIndex = 0;
    this.write(`${S_BAR}\n`);
    await this.frames((now) => {
      start ??= now;
      if (now - start >= duration) return false;
      if (now - last >= SPINNER_INTERVAL_MS - FRAME_SLACK_MS) {
        last = now;
        const available = Math.max(1, this.terminal.cols - 3);
        const label =
          text.length > available ? `${text.slice(0, available - 1)}…` : text;
        const frame = frames[frameIndex++ % frames.length]!;
        this.write(`\r\x1b[K${magenta(frame)}  ${label}`);
      }
      return true;
    });
    this.write(`\r\x1b[K${S_STEP_SUBMIT}  ${completed}\n`);
  }

  outro(message: string): void {
    this.write(`${S_BAR}\n${S_BAR_END}  ${message}\n`);
  }

  finish(): void {
    this.write("\n\x1b[0m$ ");
  }
}

export { blue, cyan, gray, green, magenta, yellow };
