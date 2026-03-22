import type { ResolvedDealConfig } from "../../config.js";
import type { Watch } from "../../types.js";
import {
  buildDiscoveryImportPreview,
  buildDiscoverySearchQuery,
  describeDiscoveryPolicy,
  fetchDiscoveryCandidates,
  normalizeDiscoveryUrls,
  searchDiscoveryCandidates,
} from "../../lib/discovery.js";

export interface DiscoveryService {
  normalizeUrls(urls: string[], cfg: ResolvedDealConfig): string[];
  buildSearchQuery(watch: Watch, hints?: string[]): string;
  describePolicy(cfg: ResolvedDealConfig): ReturnType<typeof describeDiscoveryPolicy>;
  search(args: Parameters<typeof searchDiscoveryCandidates>[0]): ReturnType<typeof searchDiscoveryCandidates>;
  fetch(args: Parameters<typeof fetchDiscoveryCandidates>[0]): ReturnType<typeof fetchDiscoveryCandidates>;
  buildImportPreview(args: Parameters<typeof buildDiscoveryImportPreview>[0]): ReturnType<typeof buildDiscoveryImportPreview>;
}

export function createDiscoveryService(): DiscoveryService {
  return {
    normalizeUrls: normalizeDiscoveryUrls,
    buildSearchQuery: buildDiscoverySearchQuery,
    describePolicy: describeDiscoveryPolicy,
    search: searchDiscoveryCandidates,
    fetch: fetchDiscoveryCandidates,
    buildImportPreview: buildDiscoveryImportPreview,
  };
}
