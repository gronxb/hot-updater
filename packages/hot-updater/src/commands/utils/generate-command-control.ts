export class GenerateExit extends Error {
  readonly code: number;

  constructor(code: number) {
    super(`process.exit(${code})`);
    this.code = code;
  }
}

export const requestGenerateExit = (code: number): never => {
  throw new GenerateExit(code);
};
