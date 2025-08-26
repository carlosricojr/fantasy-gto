/// <reference lib="webworker" />
import { Serwist } from "serwist";
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
  runtimeCaching: defaultCache,
});

serwist.addEventListeners();


