import type { Terminal } from "@xterm/xterm";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Clack-style symbols
const S_BAR = "\x1b[90m│\x1b[0m";
const S_BAR_END = "\x1b[90m└\x1b[0m";
const S_STEP_SUBMIT = "\x1b[32m◇\x1b[0m";
const S_SUCCESS = "\x1b[32m✓\x1b[0m";

// Color helpers
const cyan = (text: string) => `\x1b[36m${text}\x1b[0m`;
const gray = (text: string) => `\x1b[90m${text}\x1b[0m`;
const green = (text: string) => `\x1b[32m${text}\x1b[0m`;
const white = (text: string) => `\x1b[97m${text}\x1b[0m`;
const magenta = (text: string) => `\x1b[35m${text}\x1b[0m`;

export class ClackRenderer {
  constructor(private terminal: Terminal) {}

  async typeText(text: string, color = "\x1b[0m"): Promise<void> {
    for (const char of text) {
      this.terminal.write(color + char);
      await sleep(30);
    }
  }

  async intro(title: string): Promise<void> {
    const boxWidth = 47;
    const paddedTitle = title.padStart(
      Math.floor((boxWidth + title.length) / 2),
    );
    const finalTitle = paddedTitle.padEnd(boxWidth);

    this.terminal.write(
      `${green("╭───────────────────────────────────────────────╮")}\r\n`,
    );
    this.terminal.write(
      `${green("│")}${white("                                               ")}${green("│")}\r\n`,
    );
    this.terminal.write(`${green("│")}${white(finalTitle)}${green("│")}\r\n`);
    this.terminal.write(
      `${green("│")}${white("                                               ")}${green("│")}\r\n`,
    );
    this.terminal.write(
      `${green("╰───────────────────────────────────────────────╯")}\r\n\r\n`,
    );
    await sleep(100);
  }

  log = {
    step: async (message: string): Promise<void> => {
      this.terminal.write(`${S_BAR}\r\n`);
      this.terminal.write(`${S_STEP_SUBMIT}  ${message}\r\n`);
    },

    success: async (message: string): Promise<void> => {
      this.terminal.write(`${S_BAR}  ${S_SUCCESS} ${message}\r\n`);
    },

    message: async (message: string): Promise<void> => {
      this.terminal.write(`${S_STEP_SUBMIT}  ${message}\r\n`);
    },
  };

  async spinner(text: string, duration: number): Promise<void> {
    const frames = ["◒", "◐", "◓", "◑"];
    const startTime = Date.now();
    let frameIndex = 0;

    this.terminal.write(`${S_BAR}\r\n`);
    while (Date.now() - startTime < duration) {
      this.terminal.write(`\r${magenta(frames[frameIndex])}  ${text}`);
      frameIndex = (frameIndex + 1) % frames.length;
      await sleep(80);
    }
    this.terminal.write("\r\x1b[K");
  }

  async outro(message: string): Promise<void> {
    this.terminal.write(`${S_BAR}\r\n`);
    this.terminal.write(`${S_BAR_END}  ${message}\r\n`);
  }
}

// Export color helpers for use in demos
export { cyan, gray, green, white, magenta };
