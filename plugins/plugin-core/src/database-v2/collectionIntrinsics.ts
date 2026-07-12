const MapConstructor = Map;
const SetConstructor = Set;
const WeakSetConstructor = WeakSet;
const reflectApply = Reflect.apply;
const mapDelete = Map.prototype.delete;
const mapForEach = Map.prototype.forEach;
const mapGet = Map.prototype.get;
const mapSet = Map.prototype.set;
const setAdd = Set.prototype.add;
const setDelete = Set.prototype.delete;
const setForEach = Set.prototype.forEach;
const setHas = Set.prototype.has;
const weakSetAdd = WeakSet.prototype.add;
const weakSetDelete = WeakSet.prototype.delete;
const weakSetHas = WeakSet.prototype.has;

export const createMapV2 = <K, V>(): Map<K, V> => new MapConstructor<K, V>();

export const getMapValueV2 = <K, V>(map: Map<K, V>, key: K): V | undefined =>
  reflectApply(mapGet, map, [key]);

export const setMapValueV2 = <K, V>(map: Map<K, V>, key: K, value: V): void => {
  reflectApply(mapSet, map, [key, value]);
};

export const deleteMapValueV2 = <K, V>(map: Map<K, V>, key: K): boolean =>
  reflectApply(mapDelete, map, [key]);

export const mapValuesV2 = <K, V>(map: Map<K, V>): readonly V[] => {
  const values: V[] = [];
  reflectApply(mapForEach, map, [
    (value: V) => {
      values[values.length] = value;
    },
  ]);
  return values;
};

export const createSetV2 = <T>(): Set<T> => new SetConstructor<T>();

export const addSetValueV2 = <T>(set: Set<T>, value: T): void => {
  reflectApply(setAdd, set, [value]);
};

export const hasSetValueV2 = <T>(set: Set<T>, value: T): boolean =>
  reflectApply(setHas, set, [value]);

export const deleteSetValueV2 = <T>(set: Set<T>, value: T): boolean =>
  reflectApply(setDelete, set, [value]);

export const setValuesV2 = <T>(set: Set<T>): readonly T[] => {
  const values: T[] = [];
  reflectApply(setForEach, set, [
    (value: T) => {
      values[values.length] = value;
    },
  ]);
  return values;
};

export const createWeakSetV2 = <T extends WeakKey>(): WeakSet<T> =>
  new WeakSetConstructor<T>();

export const addWeakSetValueV2 = <T extends WeakKey>(
  set: WeakSet<T>,
  value: T,
): void => {
  reflectApply(weakSetAdd, set, [value]);
};

export const hasWeakSetValueV2 = <T extends WeakKey>(
  set: WeakSet<T>,
  value: T,
): boolean => reflectApply(weakSetHas, set, [value]);

export const deleteWeakSetValueV2 = <T extends WeakKey>(
  set: WeakSet<T>,
  value: T,
): boolean => reflectApply(weakSetDelete, set, [value]);
