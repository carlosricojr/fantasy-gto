/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as billing from "../billing.js";
import type * as contests from "../contests.js";
import type * as crons from "../crons.js";
import type * as draft from "../draft.js";
import type * as http from "../http.js";
import type * as ingest from "../ingest.js";
import type * as jobs from "../jobs.js";
import type * as leagues from "../leagues.js";
import type * as lib_auth from "../lib/auth.js";
import type * as projections from "../projections.js";
import type * as season from "../season.js";
import type * as users from "../users.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  billing: typeof billing;
  contests: typeof contests;
  crons: typeof crons;
  draft: typeof draft;
  http: typeof http;
  ingest: typeof ingest;
  jobs: typeof jobs;
  leagues: typeof leagues;
  "lib/auth": typeof lib_auth;
  projections: typeof projections;
  season: typeof season;
  users: typeof users;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
