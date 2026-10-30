import type { Writable } from "node:stream";

import * as clack from "@clack/prompts";

import { colors } from "./colors";
import { displayWidth, truncateLine } from "./messageLines";
import { maskSecretValues } from "./secretMasking";
import { type StepCapture, setStepCapture, stepCapture } from "./stepCapture";

type Output = Writable & { isTTY?: boolean; columns?: number };

/** The widest a finished step's line is, after clack's 3-column gutter. */
const STEP_WIDTH = 73;

/** The room the spinner's symbol and its `[12m 34s]` timer take. */
const LIVE_LINE_CHROME = 3 + 10;

/** `4.2s`, `38s`, `6m41s`, `1h02m`. */
export const formatDuration = (ms: number): string => {
  if (ms < 9_950) return `${(Math.max(0, ms) / 1000).toFixed(1)}s`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`;
  }
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
};

/**
 * `message` with `duration` at the right edge of a step's line, the message
 * cut with `…` when the line would be wider.
 */
export const withDuration = (
  message: string,
  ms: number,
  width: number = STEP_WIDTH,
): string => {
  const duration = formatDuration(ms);
  // Never wraps: a longer message is cut.
  const text = truncateLine(message, width - duration.length - 2);
  const gap = Math.max(2, width - displayWidth(text) - duration.length);
  return `${text}${" ".repeat(gap)}${colors.dim(duration)}`;
};

/** How a finished step's line is marked. */
export type StepLevel = "step" | "info" | "warn";

/**
 * A step of a command that takes a while, shown as one line: at a terminal,
 * a spinner whose line shows the step's current detail and its elapsed
 * time, which ends as the step's line with its duration; elsewhere, such as
 * in CI, only that last line.
 *
 * While it runs, what other code prints through `p` is held: a spinner's
 * messages become the step's detail, and logs print after the step's line,
 * but an error ends the step as failed first and prints at once, since the
 * process may exit right after it.
 */
export interface Step {
  /** Starts the step, once: nothing shows before. */
  start(): Step;
  /** Shows `detail` after the title on the live line, or the title alone. */
  update(detail?: string): void;
  /**
   * Ends the step with `message`, the title by default, and its duration,
   * marked as a finished step or with `level`.
   */
  succeed(message?: string, options?: { level?: StepLevel }): void;
  /** Ends the step as failed, with `message` or `<title> failed`. */
  fail(message?: string): void;
  /** Milliseconds since it started, or 0 before. */
  readonly elapsedMs: number;
  /** Whether it started and has not ended. */
  readonly active: boolean;
}

interface StepOptions {
  output?: Output;
}

const isLive = (output: Output) => clack.isTTY(output) && !clack.isCI();

/**
 * A step that shows nothing until `start()`. A step created while another
 * runs is part of it: its title and detail become the running step's detail,
 * and its failure fails the running step.
 */
export const createStep = (
  title: string,
  { output = process.stdout as Output }: StepOptions = {},
): Step => {
  let startedAt: number | undefined;
  let ended = false;
  let detail: string | undefined;
  let spinner: ReturnType<typeof clack.spinner> | undefined;
  let ticker: ReturnType<typeof setInterval> | undefined;
  let held: (() => void)[] = [];
  let outer: StepCapture | undefined;

  const liveMessage = () => {
    const text = maskSecretValues(detail ? `${title} · ${detail}` : title);
    // A pseudo-terminal may report 0 columns.
    const columns = output.columns || 80;
    return truncateLine(text, Math.max(20, columns - LIVE_LINE_CHROME));
  };

  const finish = (write: () => void) => {
    if (startedAt === undefined || ended) return;
    ended = true;
    if (ticker) clearInterval(ticker);
    if (outer) {
      // Part of a running step: its line is that step's.
      outer.update(undefined);
      return;
    }
    setStepCapture(undefined);
    if (spinner) {
      // The spinner's guide line stays above the line written in its place.
      spinner.clear();
    }
    write();
    const logs = held;
    held = [];
    for (const log of logs) log();
  };

  const logOptions = () => ({ output, spacing: spinner ? 0 : 1 });

  const step: Step = {
    start() {
      if (startedAt !== undefined) return step;
      startedAt = performance.now();
      outer = stepCapture();
      if (outer) {
        outer.update(title);
        return step;
      }
      setStepCapture({
        update: (value) => step.update(value),
        hold: (log) => {
          held.push(log);
        },
        interrupt: (message) => step.fail(message),
      });
      if (isLive(output)) {
        spinner = clack.spinner({ indicator: "timer", output });
        spinner.start(liveMessage());
        // Follows the terminal's width as it is resized.
        ticker = setInterval(() => spinner?.message(liveMessage()), 1000);
        ticker.unref?.();
      }
      return step;
    },
    update(value) {
      if (startedAt === undefined || ended) return;
      if (outer) {
        outer.update(value ? `${title} · ${value}` : title);
        return;
      }
      detail = value;
      spinner?.message(liveMessage());
    },
    succeed(message = title, { level = "step" } = {}) {
      const elapsed = step.elapsedMs;
      finish(() => {
        const line = maskSecretValues(withDuration(message, elapsed));
        if (level === "info") clack.log.info(line, logOptions());
        else if (level === "warn") clack.log.warn(line, logOptions());
        else clack.log.step(line, logOptions());
      });
    },
    fail(message = `${title} failed`) {
      const elapsed = step.elapsedMs;
      if (outer && startedAt !== undefined && !ended) {
        // Part of a running step, it ends that step as failed with its
        // message, as an inner spinner's error does.
        ended = true;
        outer.interrupt(message);
        return;
      }
      finish(() => {
        clack.log.error(
          maskSecretValues(withDuration(message, elapsed)),
          logOptions(),
        );
      });
    },
    get elapsedMs() {
      return startedAt === undefined ? 0 : performance.now() - startedAt;
    },
    get active() {
      return startedAt !== undefined && !ended;
    },
  };
  return step;
};

/**
 * Ends the running step as failed, if one runs, before a command prints
 * its error.
 */
export const failActiveStep = (): void => {
  stepCapture()?.interrupt();
};

/** A step, started. */
export const startStep = (title: string, options?: StepOptions): Step =>
  createStep(title, options).start();

/**
 * Runs `run` as a step titled `title`, which ends with `done(result)`, or as
 * failed when `run` throws.
 */
export const withStep = async <T>(
  title: string,
  run: (step: Step) => Promise<T>,
  done: (result: T) => string = () => title,
  options?: StepOptions,
): Promise<T> => {
  const step = startStep(title, options);
  try {
    const result = await run(step);
    step.succeed(done(result));
    return result;
  } catch (error) {
    step.fail();
    throw error;
  }
};
