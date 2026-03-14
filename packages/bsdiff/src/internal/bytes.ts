export type BytesLike = Uint8Array | ArrayBuffer;

export function toUint8Array(value: BytesLike): Uint8Array {
  if (value instanceof Uint8Array) {
    return value;
  }
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }
  throw new TypeError("Expected Uint8Array or ArrayBuffer");
}

export function equalsBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) {
    return false;
  }
  for (let i = 0; i < a.byteLength; i += 1) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}

export function cloneBytes(value: Uint8Array): Uint8Array {
  return new Uint8Array(value);
}
