import * as clack from "@clack/prompts";

import { nonInteractiveReason } from "./interactive";
import { maskSecretValues } from "./secretMasking";

type SpinnerOptions = NonNullable<Parameters<typeof clack.spinner>[0]>;
type Spinner = ReturnType<typeof clack.spinner>;
type Progress = ReturnType<typeof clack.progress>;

const maskMessage = (message: string | undefined) =>
  message === undefined ? message : maskSecretValues(message);

const log: typeof clack.log = {
  message: (message, options) =>
    clack.log.message(
      Array.isArray(message)
        ? message.map(maskSecretValues)
        : maskMessage(message),
      options,
    ),
  info: (message, options) =>
    clack.log.info(maskSecretValues(message), options),
  success: (message, options) =>
    clack.log.success(maskSecretValues(message), options),
  step: (message, options) =>
    clack.log.step(maskSecretValues(message), options),
  warn: (message, options) =>
    clack.log.warn(maskSecretValues(message), options),
  warning: (message, options) =>
    clack.log.warning(maskSecretValues(message), options),
  error: (message, options) =>
    clack.log.error(maskSecretValues(message), options),
};

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
  const output = options.output ?? process.stdout;
  const isInteractive = clack.isTTY(output) && !clack.isCI();
  return maskSpinner(
    isInteractive ? clack.spinner(options) : createStaticSpinner(options),
  );
};

const progress: typeof clack.progress = (options = {}) => {
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
