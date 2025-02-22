import type { RpcType } from "@/src-server/rpc";
import { hc } from "hono/client";

export const api = hc<RpcType>("/rpc");

import { createQuery } from "@tanstack/solid-query";

export const createBundlesQuery = () =>
  createQuery(() => ({
    queryKey: ["getBundles"],
    queryFn: () => api.getBundles.$get().then((res) => res.json()),
    staleTime: Number.POSITIVE_INFINITY,
  }));

export const createConfigQuery = () =>
  createQuery(() => ({
    queryKey: ["getConfig"],
    queryFn: () => api.getConfig.$get().then((res) => res.json()),
    staleTime: Number.POSITIVE_INFINITY,
  }));

export const createBundleQuery = (bundleId: string) =>
  createQuery(() => ({
    queryKey: ["getBundle", bundleId],
    queryFn: () =>
      api.getBundleById.$get({ query: { bundleId } }).then((res) => res.json()),
    staleTime: Number.POSITIVE_INFINITY,
  }));
