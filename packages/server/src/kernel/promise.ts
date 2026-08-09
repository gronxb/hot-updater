const ignoreRejection = (): void => undefined;
const promiseThen = Promise.prototype.then;

export function suppressNativePromiseRejection(value: object): void {
  try {
    void Reflect.apply(promiseThen, value, [undefined, ignoreRejection]);
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
  }
}
