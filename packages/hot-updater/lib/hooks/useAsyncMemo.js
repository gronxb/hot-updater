import { useCallback, useEffect, useState } from "react";
/**
 * useAsyncMemo - A custom hook for async operations with memoization.
 *
 * @param {Function} asyncFunction - The async function to execute.
 * @param {Array} dependencies - The dependencies array for memoization.
 * @returns {Array} - An array with the result, loading state, and error state.
 */
export const useAsyncMemo = (asyncFunction, initialData, dependencies) => {
    const [data, setData] = useState(initialData);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const execute = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const result = await asyncFunction();
            setData(result);
            return result;
        }
        catch (err) {
            setError(err);
        }
        finally {
            setLoading(false);
        }
        return null;
    }, dependencies);
    useEffect(() => {
        execute();
    }, [execute]);
    const refresh = useCallback(() => {
        return execute();
    }, [execute]);
    return { data, loading, error, refresh };
};
