/// <reference types="react" />
/**
 * useAsyncMemo - A custom hook for async operations with memoization.
 *
 * @param {Function} asyncFunction - The async function to execute.
 * @param {Array} dependencies - The dependencies array for memoization.
 * @returns {Array} - An array with the result, loading state, and error state.
 */
export declare const useAsyncMemo: <T>(asyncFunction: () => Promise<T>, initialData: T, dependencies: import("react").DependencyList) => {
    data: T;
    loading: boolean;
    error: any;
    refresh: () => Promise<T | null>;
};
