export type Primitive =
  | null
  | undefined
  | string
  | number
  | boolean
  | symbol
  | bigint;

// biome-ignore lint/suspicious/noConfusingVoidType: <explanation>
export type BuiltIns = Primitive | void | Date | RegExp;

type ExcludeUndefined<T> = Exclude<T, undefined>;

export type HasMultipleCallSignatures<
  T extends (...arguments_: any[]) => unknown,
> = T extends {
  (...arguments_: infer A): unknown;
  (...arguments_: infer B): unknown;
}
  ? B extends A
    ? A extends B
      ? false
      : true
    : true
  : false;

export type RequiredDeep<
  T,
  E extends ExcludeUndefined<T> = ExcludeUndefined<T>,
> = E extends BuiltIns
  ? E
  : E extends Map<infer KeyType, infer ValueType>
    ? Map<RequiredDeep<KeyType>, RequiredDeep<ValueType>>
    : E extends Set<infer ItemType>
      ? Set<RequiredDeep<ItemType>>
      : E extends ReadonlyMap<infer KeyType, infer ValueType>
        ? ReadonlyMap<RequiredDeep<KeyType>, RequiredDeep<ValueType>>
        : E extends ReadonlySet<infer ItemType>
          ? ReadonlySet<RequiredDeep<ItemType>>
          : E extends WeakMap<infer KeyType, infer ValueType>
            ? WeakMap<RequiredDeep<KeyType>, RequiredDeep<ValueType>>
            : E extends WeakSet<infer ItemType>
              ? WeakSet<RequiredDeep<ItemType>>
              : E extends Promise<infer ValueType>
                ? Promise<RequiredDeep<ValueType>>
                : E extends (...arguments_: any[]) => unknown
                  ? {} extends RequiredObjectDeep<E>
                    ? E
                    : HasMultipleCallSignatures<E> extends true
                      ? E
                      : ((...arguments_: Parameters<E>) => ReturnType<E>) &
                          RequiredObjectDeep<E>
                  : E extends object
                    ? E extends Array<infer ItemType> // Test for arrays/tuples, per https://github.com/microsoft/TypeScript/issues/35156
                      ? ItemType[] extends E // Test for arrays (non-tuples) specifically
                        ? Array<RequiredDeep<ItemType>> // Recreate relevant array type to prevent eager evaluation of circular reference
                        : RequiredObjectDeep<E> // Tuples behave properly
                      : RequiredObjectDeep<E>
                    : unknown;

type RequiredObjectDeep<ObjectType extends object> = {
  [KeyType in keyof ObjectType]-?: RequiredDeep<ObjectType[KeyType]>;
};
