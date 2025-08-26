/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";
import type * as functions__guards from "../functions/_guards.js";
import type * as functions_accuracy from "../functions/accuracy.js";
import type * as functions_audit from "../functions/audit.js";
import type * as functions_auth from "../functions/auth.js";
import type * as functions_billing from "../functions/billing.js";
import type * as functions_cache from "../functions/cache.js";
import type * as functions_dst from "../functions/dst.js";
import type * as functions_leagues from "../functions/leagues.js";
import type * as functions_lineup from "../functions/lineup.js";
import type * as functions_onboarding from "../functions/onboarding.js";
import type * as functions_proj from "../functions/proj.js";
import type * as functions_sync_espn from "../functions/sync/espn.js";
import type * as functions_waiver from "../functions/waiver.js";

/**
 * A utility for referencing Convex functions in your app's API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
declare const fullApi: ApiFromModules<{
  "functions/_guards": typeof functions__guards;
  "functions/accuracy": typeof functions_accuracy;
  "functions/audit": typeof functions_audit;
  "functions/auth": typeof functions_auth;
  "functions/billing": typeof functions_billing;
  "functions/cache": typeof functions_cache;
  "functions/dst": typeof functions_dst;
  "functions/leagues": typeof functions_leagues;
  "functions/lineup": typeof functions_lineup;
  "functions/onboarding": typeof functions_onboarding;
  "functions/proj": typeof functions_proj;
  "functions/sync/espn": typeof functions_sync_espn;
  "functions/waiver": typeof functions_waiver;
}>;
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;
