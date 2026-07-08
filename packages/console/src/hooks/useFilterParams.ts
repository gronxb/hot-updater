import { useNavigate, useSearch } from "@tanstack/react-router";
import {
  createContext,
  createElement,
  type ReactNode,
  useContext,
  useMemo,
  useState,
} from "react";

export interface BundleFilters {
  channel?: string;
  platform?: "ios" | "android";
  page?: number;
  after?: string;
  before?: string;
}

interface BundleSearchParams {
  channel: string | undefined;
  platform: "ios" | "android" | undefined;
  page: number | undefined;
  after: string | undefined;
  before: string | undefined;
  bundleId: string | undefined;
  expandedBundleId: string | undefined;
}

type FilterParamsValue = {
  bundleId: string | undefined;
  expandedBundleId: string | undefined;
  filters: BundleFilters;
  resetFilters: () => void;
  setBundleId: (
    nextBundleId: string | undefined,
    newFilters?: Partial<BundleFilters>,
  ) => void;
  setExpandedBundleId: (
    nextExpandedBundleId: string | undefined,
    newFilters?: Partial<BundleFilters>,
  ) => void;
  setFilters: (newFilters: Partial<BundleFilters>) => void;
};

const FilterParamsContext = createContext<FilterParamsValue | null>(null);

const getNextFilters = (
  currentFilters: BundleFilters,
  newFilters: Partial<BundleFilters>,
) => {
  const hasChannel = Object.hasOwn(newFilters, "channel");
  const hasPlatform = Object.hasOwn(newFilters, "platform");
  const hasPage = Object.hasOwn(newFilters, "page");
  const hasAfter = Object.hasOwn(newFilters, "after");
  const hasBefore = Object.hasOwn(newFilters, "before");
  const shouldResetPagination = hasChannel || hasPlatform;
  const nextPage =
    hasPage && newFilters.page !== undefined && newFilters.page > 1
      ? newFilters.page
      : undefined;

  return {
    channel: hasChannel ? newFilters.channel : currentFilters.channel,
    platform: hasPlatform ? newFilters.platform : currentFilters.platform,
    page: shouldResetPagination
      ? undefined
      : hasPage
        ? nextPage
        : currentFilters.page,
    after: shouldResetPagination
      ? undefined
      : hasAfter
        ? newFilters.after
        : currentFilters.after,
    before: shouldResetPagination
      ? undefined
      : hasBefore
        ? newFilters.before
        : currentFilters.before,
  } satisfies BundleFilters;
};

export function ConsoleFilterParamsProvider({
  children,
  initialBundleId,
  initialExpandedBundleId,
  initialFilters = {},
}: {
  children: ReactNode;
  initialBundleId?: string;
  initialExpandedBundleId?: string;
  initialFilters?: BundleFilters;
}) {
  const [state, setState] = useState<BundleSearchParams>(() => ({
    channel: initialFilters.channel,
    platform: initialFilters.platform,
    page: initialFilters.page,
    after: initialFilters.after,
    before: initialFilters.before,
    bundleId: initialBundleId,
    expandedBundleId: initialExpandedBundleId,
  }));

  const value = useMemo<FilterParamsValue>(() => {
    const filters: BundleFilters = {
      channel: state.channel,
      platform: state.platform,
      page: state.page,
      after: state.after,
      before: state.before,
    };

    return {
      filters,
      bundleId: state.bundleId,
      expandedBundleId: state.expandedBundleId,
      setFilters: (newFilters) => {
        setState((currentState) => ({
          ...getNextFilters(currentState, newFilters),
          bundleId: undefined,
          expandedBundleId: undefined,
        }));
      },
      setBundleId: (nextBundleId, newFilters = {}) => {
        setState((currentState) => ({
          ...getNextFilters(currentState, newFilters),
          bundleId: nextBundleId,
          expandedBundleId: undefined,
        }));
      },
      setExpandedBundleId: (nextExpandedBundleId, newFilters = {}) => {
        setState((currentState) => ({
          ...getNextFilters(currentState, newFilters),
          bundleId: currentState.bundleId,
          expandedBundleId: nextExpandedBundleId,
        }));
      },
      resetFilters: () => {
        setState({
          channel: undefined,
          platform: undefined,
          page: undefined,
          after: undefined,
          before: undefined,
          bundleId: undefined,
          expandedBundleId: undefined,
        });
      },
    };
  }, [state]);

  return createElement(FilterParamsContext.Provider, { value }, children);
}

function useRouterFilterParams(): FilterParamsValue {
  const search = useSearch({ from: "/" });
  const navigate = useNavigate();

  const filters: BundleFilters = {
    channel: search.channel as string | undefined,
    platform: search.platform as "ios" | "android" | undefined,
    page: search.page as number | undefined,
    after: search.after as string | undefined,
    before: search.before as string | undefined,
  };
  const bundleId = search.bundleId as string | undefined;
  const expandedBundleId = search.expandedBundleId as string | undefined;

  const navigateWithSearch = (
    nextSearch: BundleSearchParams,
    options?: { resetScroll?: boolean },
  ) => {
    void navigate({
      to: "/",
      search: nextSearch,
      resetScroll: options?.resetScroll,
    });
  };

  const setFilters = (newFilters: Partial<BundleFilters>) => {
    navigateWithSearch({
      ...getNextFilters(filters, newFilters),
      bundleId: undefined,
      expandedBundleId: undefined,
    });
  };

  const setBundleId = (
    nextBundleId: string | undefined,
    newFilters: Partial<BundleFilters> = {},
  ) => {
    navigateWithSearch(
      {
        ...getNextFilters(filters, newFilters),
        bundleId: nextBundleId,
        expandedBundleId: undefined,
      },
      {
        resetScroll: false,
      },
    );
  };

  const setExpandedBundleId = (
    nextExpandedBundleId: string | undefined,
    newFilters: Partial<BundleFilters> = {},
  ) => {
    navigateWithSearch(
      {
        ...getNextFilters(filters, newFilters),
        bundleId,
        expandedBundleId: nextExpandedBundleId,
      },
      {
        resetScroll: false,
      },
    );
  };

  const resetFilters = () => {
    navigateWithSearch({
      channel: undefined,
      platform: undefined,
      page: undefined,
      after: undefined,
      before: undefined,
      bundleId: undefined,
      expandedBundleId: undefined,
    });
  };

  return {
    filters,
    bundleId,
    expandedBundleId,
    setFilters,
    setBundleId,
    setExpandedBundleId,
    resetFilters,
  };
}

export function useFilterParams() {
  const context = useContext(FilterParamsContext);

  if (context) {
    return context;
  }

  return useRouterFilterParams();
}
