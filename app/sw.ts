/// <reference lib="webworker" />
import { NetworkOnly, Serwist } from "serwist";
import { defaultCache } from "@serwist/next/worker";

// Declare the injected manifest so the Serwist plugin can find it.
type PrecacheEntry = string | { url: string; revision?: string };
declare const self: ServiceWorkerGlobalScope & {
  __SW_MANIFEST: PrecacheEntry[] | undefined;
};

const serwist = new Serwist({
  precacheEntries: self.__SW_MANIFEST,
  skipWaiting: true,
  clientsClaim: true,
  navigationPreload: true,
  runtimeCaching: [
    {
      // Live picks and rosters must fail when their refresh fails. Cache Storage
      // does not honor HTTP no-store; defaultCache otherwise falls back to a
      // cached API response, which callers could mistake for a fresh snapshot.
      matcher: ({ sameOrigin, url }) =>
        (sameOrigin && url.pathname === "/api/weekly-lineup") ||
        url.hostname === "api.sleeper.app",
      method: "GET",
      handler: new NetworkOnly({ fetchOptions: { cache: "no-store" } }),
    },
    ...defaultCache,
  ],
});

serwist.addEventListeners();
