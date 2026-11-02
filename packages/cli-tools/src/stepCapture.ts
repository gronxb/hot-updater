/**
 * The running step, which `p`'s spinners and logs report to instead of the
 * terminal while it runs: see `createStep`.
 */
export interface StepCapture {
  /** Shows `detail` on the step's line. */
  update(detail: string | undefined): void;
  /** Prints `log` after the step's line. */
  hold(log: () => void): void;
  /** Ends the step as failed, with `message` when given. */
  interrupt(message?: string): void;
}

let current: StepCapture | undefined;

export const stepCapture = (): StepCapture | undefined => current;

export const setStepCapture = (capture: StepCapture | undefined): void => {
  current = capture;
};
