import * as clack from "@clack/prompts";

type SpinnerOptions = NonNullable<Parameters<typeof clack.spinner>[0]>;
type Spinner = ReturnType<typeof clack.spinner>;

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
    log: typeof clack.log.success,
  ) => {
    if (!active) return;
    active = false;
    const finalMessage = message || latestMessage;
    if (finalMessage) log(finalMessage, logOptions);
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
  return isInteractive ? clack.spinner(options) : createStaticSpinner(options);
};

const progress: typeof clack.progress = (options = {}) => {
  const output = options.output ?? process.stdout;
  const isInteractive = clack.isTTY(output) && !clack.isCI();
  if (isInteractive) return clack.progress(options);

  const staticSpinner = createStaticSpinner(options);
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
    const result = await task.task(taskSpinner.message);
    taskSpinner.stop(result || task.title);
  }
};

export const p: typeof clack = {
  ...clack,
  progress,
  spinner,
  tasks,
};

export type PromptProgress = ReturnType<typeof p.progress>;
export type PromptSpinner = ReturnType<typeof p.spinner>;
