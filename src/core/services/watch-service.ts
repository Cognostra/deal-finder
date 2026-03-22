import { importWatches } from "../../lib/store.js";
import type { ResolvedDealConfig } from "../../config.js";
import { canonicalizeWatchUrl } from "../../lib/url-policy.js";
import type { WatchSelector } from "../../types.js";
import type { WatchRepository } from "../repositories.js";

export function createWatchService(args: {
  watchRepository: WatchRepository;
}) {
  const { watchRepository } = args;

  return {
    async list(includeDisabled = false) {
      const watches = await watchRepository.list();
      return includeDisabled ? watches : watches.filter((watch) => watch.enabled);
    },
    search(selector: WatchSelector) {
      return watchRepository.search(selector);
    },
    get(id: string) {
      return watchRepository.get(id);
    },
    async add(
      input: Parameters<WatchRepository["add"]>[0],
      cfg: ResolvedDealConfig,
    ) {
      return watchRepository.add({
        ...input,
        url: canonicalizeWatchUrl(input.url, cfg).toString(),
      });
    },
    async update(
      id: string,
      patch: Parameters<WatchRepository["update"]>[1],
      cfg: ResolvedDealConfig,
    ) {
      return watchRepository.update(id, {
        ...patch,
        url: patch.url ? canonicalizeWatchUrl(patch.url, cfg).toString() : undefined,
      });
    },
    setEnabled(ids: string[], enabled: boolean) {
      return watchRepository.setEnabled(ids, enabled);
    },
    remove(id: string) {
      return watchRepository.remove(id);
    },
    exportWatches(args: Parameters<WatchRepository["exportWatches"]>[0]) {
      return watchRepository.exportWatches(args);
    },
    async importWatches(
      watches: Parameters<WatchRepository["importWatches"]>[0],
      mode: Parameters<WatchRepository["importWatches"]>[1],
      cfg: ResolvedDealConfig,
      options?: Parameters<WatchRepository["importWatches"]>[2],
    ) {
      return watchRepository.importWatches(
        watches.map((watch) => ({
          ...watch,
          url: canonicalizeWatchUrl(watch.url, cfg).toString(),
        })),
        mode,
        options,
      );
    },
    async previewImport(
      watches: Parameters<WatchRepository["importWatches"]>[0],
      mode: Parameters<WatchRepository["importWatches"]>[1],
      cfg: ResolvedDealConfig,
      options?: Parameters<WatchRepository["importWatches"]>[2],
    ) {
      const store = await watchRepository.loadStore();
      return importWatches(
        structuredClone(store),
        watches.map((watch) => ({
          ...watch,
          url: canonicalizeWatchUrl(watch.url, cfg).toString(),
        })),
        mode,
        options,
      );
    },
  };
}
