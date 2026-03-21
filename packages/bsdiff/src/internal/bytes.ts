export type Bytes = Uint8Array<ArrayBuffer>;
export type BytesLike = Uint8Array<ArrayBufferLike> | ArrayBufferLike;

export function toUint8Array(value: BytesLike): Bytes {
  if (value instanceof Uint8Array) {
    return Uint8Array.from(value);
  }
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }
  if (
    typeof SharedArrayBuffer !== "undefined" &&
    value instanceof SharedArrayBuffer
  ) {
    return Uint8Array.from(new Uint8Array(value));
  }
  throw new TypeError("Expected Uint8Array or ArrayBufferLike");
}

export function equalsBytes(a: Bytes, b: Bytes): boolean {
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

export function cloneBytes(value: Uint8Array<ArrayBufferLike>): Bytes {
  return Uint8Array.from(value);
}
