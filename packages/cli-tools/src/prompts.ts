import * as clack from "@clack/prompts";

import { nonInteractiveReason } from "./interactive";
import { maskSecretValues } from "./secretMasking";
import { type StepCapture, stepCapture } from "./stepCapture";

type SpinnerOptions = NonNullable<Parameters<typeof clack.spinner>[0]>;
type Spinner = ReturnType<typeof clack.spinner>;
type Progress = ReturnType<typeof clack.progress>;

const maskMessage = (message: string | undefined) =>
  message === undefined ? message : maskSecretValues(message);

/**
 * Prints a log line, or, while a step runs, holds it until the step's line
 * prints. An info line says what the step is doing, so it shows as the
 * step's detail instead; an error ends the step first and prints at once,
 * since the process may exit right after it.
 */
const logThroughStep =
  <Args extends unknown[]>(
    write: (...args: Args) => void,
    { inStep = "hold" }: { inStep?: "hold" | "detail" | "interrupt" } = {},
  ) =>
  (...args: Args): void => {
    const capture = stepCapture();
    if (!capture) return write(...args);
    if (inStep === "interrupt") {
      capture.interrupt();
      return write(...args);
    }
    if (inStep === "detail") {
      const message = args[0] as string | string[] | undefined;
      const text = Array.isArray(message)
        ? message.join("\n")
        : (message ?? "");
      capture.update(maskSecretValues(text.split("\n")[0] ?? ""));
      return;
    }
    capture.hold(() => write(...args));
  };

const log: typeof clack.log = {
  message: logThroughStep((message, options) =>
    clack.log.message(
      Array.isArray(message)
        ? message.map(maskSecretValues)
        : maskMessage(message),
      options,
    ),
  ),
  info: logThroughStep(
    (message, options) => clack.log.info(maskSecretValues(message), options),
    { inStep: "detail" },
  ),
  success: logThroughStep((message, options) =>
    clack.log.success(maskSecretValues(message), options),
  ),
  step: logThroughStep((message, options) =>
    clack.log.step(maskSecretValues(message), options),
  ),
  warn: logThroughStep((message, options) =>
    clack.log.warn(maskSecretValues(message), options),
  ),
  warning: logThroughStep((message, options) =>
    clack.log.warning(maskSecretValues(message), options),
  ),
  error: logThroughStep(
    (message, options) => clack.log.error(maskSecretValues(message), options),
    { inStep: "interrupt" },
  ),
};

/** A spinner inside a running step, whose messages are the step's detail. */
const spinnerInStep = (capture: StepCapture): Spinner => ({
  start: (message) => capture.update(message),
  message: (message) => capture.update(message),
  stop: () => capture.update(undefined),
  cancel: () => capture.update(undefined),
  error: (message) => capture.interrupt(message || undefined),
  clear: () => capture.update(undefined),
  get isCancelled() {
    return false;
  },
});

const maskSpinner = (target: Spinner): Spinner => ({
  start: (message) => target.start(maskMessage(message)),
  stop: (message) => target.stop(maskMessage(message)),
  cancel: (message) => target.cancel(maskMessage(message)),
  error: (message) => target.error(maskMessage(message)),
  message: (message) => target.message(maskMessage(message)),
  clear: () => target.clear(),
  get isCancelled() {
    return target.isCancelled;
  },
});

const maskProgress = (target: Progress): Progress => ({
  ...maskSpinner(target),
  advance: (step, message) => target.advance(step, maskMessage(message)),
  get isCancelled() {
    return target.isCancelled;
  },
});

const createStaticSpinner = ({
  onCancel,
  output = process.stdout,
  withGuide,
}: SpinnerOptions = {}): Spinner => {
  let active = false;
  let cancelled = false;
  let latestMessage = "";
  const logOptions = { output, withGuide };
  const finish = (
    message: string | undefined,
    logLine: typeof clack.log.success,
  ) => {
    if (!active) return;
    active = false;
    const finalMessage = message || latestMessage;
    if (finalMessage) logLine(finalMessage, logOptions);
  };

  return {
    start: (message = "") => {
      active = true;
      latestMessage = message;
      if (message) clack.log.step(message, logOptions);
    },
    stop: (message) => finish(message, clack.log.success),
    cancel: (message) => {
      const wasActive = active;
      cancelled = wasActive;
      finish(message, clack.log.warn);
      if (wasActive) onCancel?.();
    },
    error: (message) => finish(message, clack.log.error),
    message: (message = "") => {
      latestMessage = message;
    },
    clear: () => {
      active = false;
    },
    get isCancelled() {
      return cancelled;
    },
  };
};

const spinner: typeof clack.spinner = (options = {}) => {
  const capture = stepCapture();
  if (capture) return spinnerInStep(capture);
  const output = options.output ?? process.stdout;
  const isInteractive = clack.isTTY(output) && !clack.isCI();
  return maskSpinner(
    isInteractive ? clack.spinner(options) : createStaticSpinner(options),
  );
};

const progress: typeof clack.progress = (options = {}) => {
  const capture = stepCapture();
  if (capture) {
    const inStep = spinnerInStep(capture);
    return {
      ...inStep,
      advance: (_step, message) => {
        if (message) capture.update(message);
      },
      get isCancelled() {
        return false;
      },
    };
  }
  const output = options.output ?? process.stdout;
  const isInteractive = clack.isTTY(output) && !clack.isCI();
  if (isInteractive) return maskProgress(clack.progress(options));

  const staticSpinner = maskSpinner(createStaticSpinner(options));
  return {
    ...staticSpinner,
    advance: (_step, message) => staticSpinner.message(message),
    get isCancelled() {
      return staticSpinner.isCancelled;
    },
  };
};

const tasks: typeof clack.tasks = async (taskList, options) => {
  for (const task of taskList) {
    if (task.enabled === false) continue;
    const taskSpinner = spinner(options);
    taskSpinner.start(task.title);
    try {
      const result = await task.task(taskSpinner.message);
      taskSpinner.stop(result || task.title);
    } catch (error) {
      taskSpinner.error(error instanceof Error ? error.message : String(error));
      throw error;
    }
  }
};

/**
 * The prompt, refusing to ask in CI or without a terminal: a prompt on a
 * closed or piped stdin would end as a cancel or wait forever, and one in CI
 * waits on a terminal nobody answers in. A command that can skip a prompt
 * says which option does before it asks.
 */
const requireTerminal = <Options extends { input?: unknown }, Result>(
  prompt: (options: Options) => Promise<Result>,
) => {
  return (options: Options): Promise<Result> => {
    const reason = nonInteractiveReason({
      input: (options.input ?? process.stdin) as { isTTY?: boolean },
    });
    if (reason !== undefined) {
      const message = (options as { message?: unknown }).message;
      return Promise.reject(
        new Error(
          `${typeof message === "string" ? `${message} ` : ""}The CLI asks nothing ${reason}: pass the command's options instead (see --help).`,
        ),
      );
    }
    return prompt(options);
  };
};

/**
 * `@clack/prompts` with CI-safe spinners, with every message a registered
 * credential value appears in masked (`registerSecretValue`), and with
 * prompts that refuse to ask without a terminal.
 */
export const p: typeof clack = {
  ...clack,
  autocomplete: requireTerminal(clack.autocomplete),
  autocompleteMultiselect: requireTerminal(clack.autocompleteMultiselect),
  confirm: requireTerminal(clack.confirm),
  date: requireTerminal(clack.date),
  groupMultiselect: requireTerminal(clack.groupMultiselect),
  multiline: requireTerminal(clack.multiline),
  multiselect: requireTerminal(clack.multiselect),
  password: requireTerminal(clack.password),
  path: requireTerminal(clack.path),
  select: requireTerminal(clack.select),
  selectKey: requireTerminal(clack.selectKey),
  text: requireTerminal(clack.text),
  log,
  cancel: (message, options) => clack.cancel(maskMessage(message), options),
  intro: (title, options) => clack.intro(maskMessage(title), options),
  note: (message, title, options) =>
    clack.note(maskMessage(message), maskMessage(title), options),
  outro: (message, options) => clack.outro(maskMessage(message), options),
  progress,
  spinner,
  tasks,
};

export type PromptProgress = ReturnType<typeof p.progress>;
export type PromptSpinner = ReturnType<typeof p.spinner>;
