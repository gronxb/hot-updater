import * as clack from "@clack/prompts";

import { nonInteractiveReason } from "./interactive";
import { fitText, withProviderMessages } from "./messageLines";
import { maskSecretValues } from "./secretMasking";
import { type StepCapture, stepCapture } from "./stepCapture";

type SpinnerOptions = NonNullable<Parameters<typeof clack.spinner>[0]>;
type Spinner = ReturnType<typeof clack.spinner>;
type Progress = ReturnType<typeof clack.progress>;

/**
 * A message as people read it: masked first, so a line break never splits
 * a value, then its prose wrapped.
 */
const printable = (message: string): string =>
  fitText(maskSecretValues(message));

/** An error or a warning, which says what a provider's JSON body says. */
const printableFailure = (message: string): string =>
  printable(withProviderMessages(message));

const printableMessage = (message: string | undefined) =>
  message === undefined ? message : printable(message);

const printableFailureMessage = (message: string | undefined) =>
  message === undefined ? message : printableFailure(message);

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
        ? message.map((line) => printable(line))
        : printableMessage(message),
      options,
    ),
  ),
  info: logThroughStep(
    (message, options) => clack.log.info(printable(message), options),
    { inStep: "detail" },
  ),
  success: logThroughStep((message, options) =>
    clack.log.success(printable(message), options),
  ),
  step: logThroughStep((message, options) =>
    clack.log.step(printable(message), options),
  ),
  warn: logThroughStep((message, options) =>
    clack.log.warn(printableFailure(message), options),
  ),
  warning: logThroughStep((message, options) =>
    clack.log.warning(printableFailure(message), options),
  ),
  error: logThroughStep(
    (message, options) => clack.log.error(printableFailure(message), options),
    { inStep: "interrupt" },
  ),
};

/**
 * What a tool wrote, such as a build's output: masked, but printed as the
 * tool wrote it, while everything the CLI writes goes through `p`.
 */
export const toolOutput = {
  error: logThroughStep(
    (message: string, options?: Parameters<typeof clack.log.error>[1]) =>
      clack.log.error(maskSecretValues(message), options),
    { inStep: "interrupt" },
  ),
  note: (
    message: string,
    title?: string,
    options?: Parameters<typeof clack.note>[2],
  ): void =>
    clack.note(
      maskSecretValues(message),
      title === undefined ? title : maskSecretValues(title),
      options,
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

const printableSpinner = (target: Spinner): Spinner => ({
  start: (message) => target.start(printableMessage(message)),
  stop: (message) => target.stop(printableMessage(message)),
  cancel: (message) => target.cancel(printableFailureMessage(message)),
  error: (message) => target.error(printableFailureMessage(message)),
  message: (message) => target.message(printableMessage(message)),
  clear: () => target.clear(),
  get isCancelled() {
    return target.isCancelled;
  },
});

const printableProgress = (target: Progress): Progress => ({
  ...printableSpinner(target),
  advance: (step, message) => target.advance(step, printableMessage(message)),
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
  return printableSpinner(
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
  if (isInteractive) return printableProgress(clack.progress(options));

  const staticSpinner = printableSpinner(createStaticSpinner(options));
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
    return prompt(fitPromptMessage(options));
  };
};

/** Prompt `options` whose message, when it has one, is fitted. */
const fitPromptMessage = <Options>(options: Options): Options => {
  const { message } = options as { message?: unknown };
  return typeof message === "string"
    ? { ...options, message: printable(message) }
    : options;
};

/**
 * `@clack/prompts` with CI-safe spinners, with every message a registered
 * credential value appears in masked (`registerSecretValue`) and its prose
 * wrapped (`fitText`), with a provider's JSON body in an error or a warning
 * replaced with its message, and with prompts that refuse to ask without a
 * terminal.
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
  cancel: (message, options) =>
    clack.cancel(printableFailureMessage(message), options),
  intro: (title, options) => clack.intro(printableMessage(title), options),
  note: (message, title, options) =>
    clack.note(
      message === undefined ? message : maskSecretValues(message),
      title === undefined ? title : maskSecretValues(title),
      options,
    ),
  outro: (message, options) => clack.outro(printableMessage(message), options),
  progress,
  spinner,
  tasks,
};

export type PromptProgress = ReturnType<typeof p.progress>;
export type PromptSpinner = ReturnType<typeof p.spinner>;
