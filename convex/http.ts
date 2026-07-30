import { httpRouter } from "convex/server";

import { internal } from "./_generated/api";
import { httpAction } from "./_generated/server";

/**
 * HTTP endpoints.
 *
 * The Clerk webhook terminates here rather than in a Next.js route so that it can call
 * `internal` mutations directly. Those mutations are unreachable from a browser by
 * construction, which is the property that makes the billing path safe — a public
 * mutation that granted entitlements would be callable by anyone.
 *
 * Signature verification is implemented against the Svix scheme using Web Crypto rather
 * than the `svix` package, because this runs in the Convex runtime and a dependency-free
 * verification has no compatibility question. The scheme is small and fully specified.
 */

/** Reject anything older than this to blunt replay attempts. */
const TOLERANCE_MS = 5 * 60 * 1000;

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function bytesToBase64(bytes: ArrayBuffer): string {
  const view = new Uint8Array(bytes);
  let binary = "";
  for (let i = 0; i < view.length; i += 1) binary += String.fromCharCode(view[i]);
  return btoa(binary);
}

/**
 * Length-independent equality.
 *
 * A plain `===` on secrets leaks information through timing. This always compares the
 * full length of the expected value.
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Verifies a Svix-signed payload.
 *
 * The signed content is `{id}.{timestamp}.{body}`. The header carries a space-separated
 * list of `version,signature` pairs; any `v1` entry matching is sufficient, which is what
 * allows the sender to rotate secrets without downtime.
 */
async function verifySvixSignature(
  secret: string,
  body: string,
  svixId: string,
  svixTimestamp: string,
  svixSignature: string,
): Promise<boolean> {
  const timestampSeconds = Number(svixTimestamp);
  if (!Number.isFinite(timestampSeconds)) return false;
  if (Math.abs(Date.now() - timestampSeconds * 1000) > TOLERANCE_MS) return false;

  // Secrets are provided as `whsec_<base64>`; the prefix is not part of the key.
  const rawSecret = secret.startsWith("whsec_") ? secret.slice(6) : secret;

  let keyBytes: Uint8Array;
  try {
    keyBytes = base64ToBytes(rawSecret);
  } catch {
    return false;
  }

  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes as unknown as ArrayBuffer,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const signed = `${svixId}.${svixTimestamp}.${body}`;
  const digest = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signed));
  const expected = bytesToBase64(digest);

  for (const entry of svixSignature.split(" ")) {
    const [version, signature] = entry.split(",");
    if (version === "v1" && signature && timingSafeEqual(signature, expected)) {
      return true;
    }
  }
  return false;
}

interface ClerkEvent {
  type?: string;
  data?: Record<string, unknown>;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function firstString(...candidates: unknown[]): string | null {
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim() !== "") return candidate;
  }
  return null;
}

/**
 * Locates the Clerk user id.
 *
 * Clerk spells this differently across user and billing events, so several known
 * locations are tried. Returning null is meaningful: the handler audits an unresolvable
 * event rather than guessing, because guessing means applying a subscription change to the
 * wrong account.
 */
function extractClerkUserId(event: ClerkEvent): string | null {
  const data = event.data ?? {};
  const payer = asRecord(data.payer);
  const user = asRecord(data.user);

  return firstString(
    event.type?.startsWith("user.") ? data.id : null,
    data.user_id,
    data.clerk_user_id,
    payer?.user_id,
    user?.id,
  );
}

/**
 * Subscription-item statuses that describe the current period rather than a future one.
 *
 * Deliberately a whitelist: an unfamiliar status is treated as not-live, so an unknown
 * spelling of "scheduled" cannot be mistaken for the active plan.
 *
 * `canceled` belongs here. It is tempting to read it as finished, but this codebase
 * defines a cancellation as running to the end of the period already paid for —
 * `effectivePlan` keeps a canceled subscription entitled until `currentPeriodEnd`, and the
 * README promises exactly that. Excluding it would make cancel-at-period-end the one case
 * this function still gets wrong: the in-period Pro item would be rejected as not-live and
 * a status-less or upcoming free item chosen instead, revoking the paid remainder. The
 * genuinely finished spellings are `ended` and `expired`, which stay out.
 */
const LIVE_ITEM_STATUSES: ReadonlySet<string> = new Set([
  "active",
  "trialing",
  "trial",
  "past_due",
  "unpaid",
  "canceled",
  "cancelled",
]);

function extractPlanKey(event: ClerkEvent, now: number): string | null {
  const data = event.data ?? {};
  const plan = asRecord(data.plan);

  // Prefer the item that describes the subscription *now*, by period first and status
  // second.
  //
  // `items[0]` is not guaranteed to be the current one: Clerk represents a scheduled plan
  // change as an additional item on the same subscription, so taking the first blindly can
  // read the plan a subscriber is moving *to* as the plan they are on. If the parent
  // event's status is `active`, the uninformative-event guard in `billing.ts` does not fire
  // and the future plan is written as current, revoking a paid period.
  //
  // Status alone cannot settle it. A `canceled` item may be the one still entitled — a
  // cancellation runs to the end of the period already paid for — or it may be a finished
  // item sitting beside a current free one, and the two payloads look identical by status.
  // So the choice is made in two tiers: among items whose status is plausibly live, prefer
  // the one whose period covers now; failing that, the first plausibly-live item; failing
  // that, `items[0]`.
  const items = Array.isArray(data.items) ? data.items.map(asRecord) : [];

  const isLiveItem = (entry: Record<string, unknown> | null): boolean => {
    // A non-object entry describes nothing, so it must not win the search — otherwise a
    // malformed first element would be selected over a real current item behind it.
    if (entry === null) return false;
    const status = firstString(entry.status);
    return status === null || LIVE_ITEM_STATUSES.has(status.trim().toLowerCase());
  };

  // The period discriminates *among* live items. It must never promote one on its own.
  //
  // Clerk marks `period_end` optional, so a scheduled or finished item can carry a period
  // that brackets now — a start in the past with no end reads as "current" to a check that
  // ignores status. Ranking on period first therefore let an `upcoming` or `ended` item beat
  // the genuinely live one, which is the whole failure this function exists to avoid, in
  // both directions: revoking a paying subscriber, and granting Pro to a downgraded one.
  const coversNow = (entry: Record<string, unknown> | null): boolean => {
    if (!isLiveItem(entry) || entry === null) return false;
    const start = toEpochMillis(entry.period_start ?? entry.current_period_start);
    const end = toEpochMillis(entry.period_end ?? entry.current_period_end);
    if (start === null && end === null) return false;
    return (start === null || start <= now) && (end === null || end > now);
  };

  const item = items.find(coversNow) ?? items.find(isLiveItem) ?? items[0] ?? null;
  const itemPlan = item ? asRecord(item.plan) : null;

  return firstString(
    plan?.slug,
    plan?.key,
    plan?.name,
    itemPlan?.slug,
    itemPlan?.key,
    // The top-level branch anticipates `name`, so the nested one must too — otherwise a
    // plan spelled only under `data.items[0].plan.name` extracts as null.
    itemPlan?.name,
    data.plan_id,
  );
}

/**
 * The event's own timestamp, for ordering.
 *
 * `svix-timestamp` is stamped per *delivery attempt*, so a retried older event carries a
 * newer value and would defeat an ordering guard built on it. Clerk stamps the event
 * itself, so that is preferred; the delivery time is only a fallback, and when it is used
 * the guard is best-effort rather than exact.
 */
function extractEventAt(event: ClerkEvent, svixTimestamp: string): number {
  const data = event.data ?? {};
  const candidate = data.updated_at ?? data.created_at ?? data.event_at;
  const numeric =
    typeof candidate === "number"
      ? candidate
      : typeof candidate === "string" && candidate.trim() !== ""
        ? Number(candidate)
        : null;

  if (numeric !== null && Number.isFinite(numeric)) {
    // Clerk sends seconds in some payloads and milliseconds in others.
    return numeric < 1e11 ? numeric * 1000 : numeric;
  }
  return Number(svixTimestamp) * 1000;
}

/**
 * Normalises a period end to epoch milliseconds.
 *
 * Clerk sends seconds in some payloads and milliseconds in others. A value below 1e11 is
 * far too small to be a plausible millisecond timestamp, so it is treated as seconds.
 * Getting this wrong would place a cancellation deadline in 1970 and revoke a paying
 * customer's access immediately.
 */
function extractPeriodEnd(event: ClerkEvent): number | null {
  const data = event.data ?? {};
  return toEpochMillis(data.period_end ?? data.current_period_end);
}

/**
 * Coerces a Clerk timestamp to epoch milliseconds.
 *
 * Clerk sends seconds in some places and milliseconds in others. The 1e11 threshold splits
 * them: as seconds that is the year 5138, and as milliseconds it is 1973 — no real
 * subscription timestamp falls between.
 *
 * Zero and negatives are treated as absent rather than as 1970. A field defaulted to 0
 * would otherwise read as a period that began at the epoch and so covers every present
 * moment.
 */
function toEpochMillis(candidate: unknown): number | null {
  const numeric =
    typeof candidate === "number"
      ? candidate
      : typeof candidate === "string" && candidate.trim() !== ""
        ? Number(candidate)
        : null;

  if (numeric === null || !Number.isFinite(numeric) || numeric <= 0) return null;
  return numeric < 1e11 ? numeric * 1000 : numeric;
}

const clerkWebhook = httpAction(async (ctx, request) => {
  const secret = process.env.CLERK_WEBHOOK_SECRET;
  if (!secret) {
    console.error("CLERK_WEBHOOK_SECRET is not set on the Convex deployment");
    return new Response("Webhook not configured", { status: 500 });
  }

  const svixId = request.headers.get("svix-id");
  const svixTimestamp = request.headers.get("svix-timestamp");
  const svixSignature = request.headers.get("svix-signature");
  if (!svixId || !svixTimestamp || !svixSignature) {
    return new Response("Missing signature headers", { status: 400 });
  }

  const body = await request.text();
  const valid = await verifySvixSignature(
    secret,
    body,
    svixId,
    svixTimestamp,
    svixSignature,
  );
  // Deliberately vague: a precise reason would help an attacker probe the signer.
  if (!valid) return new Response("Invalid signature", { status: 400 });

  let event: ClerkEvent;
  try {
    event = JSON.parse(body) as ClerkEvent;
  } catch {
    return new Response("Malformed body", { status: 400 });
  }

  const eventType = event.type ?? "unknown";
  const clerkUserId = extractClerkUserId(event);

  try {
    if (eventType === "user.created" || eventType === "user.updated") {
      const data = event.data ?? {};
      // Clerk does not order `email_addresses` by primary status, so position 0 is not
      // the primary address. It has to be matched by `primary_email_address_id`, or a user
      // with several addresses gets an arbitrary one recorded — and that address is what
      // support and billing correspondence would key on.
      const emails = Array.isArray(data.email_addresses) ? data.email_addresses : [];
      const primaryId = firstString(data.primary_email_address_id);
      const primary =
        (primaryId === null
          ? null
          : asRecord(
              emails.find((entry) => asRecord(entry)?.id === primaryId),
            )) ?? asRecord(emails[0]);
      const email = firstString(primary?.email_address, data.email_address) ?? "";
      if (clerkUserId) {
        await ctx.runMutation(internal.users.upsertFromClerk, { clerkUserId, email });
      }
      return new Response(null, { status: 200 });
    }

    if (eventType === "user.deleted") {
      if (clerkUserId) {
        await ctx.runMutation(internal.users.deleteFromClerk, { clerkUserId });
      }
      return new Response(null, { status: 200 });
    }

    const data = event.data ?? {};
    await ctx.runMutation(internal.billing.applyClerkEvent, {
      eventType,
      clerkUserId,
      planKey: extractPlanKey(event, Date.now()),
      status: firstString(data.status),
      subscriptionId: firstString(data.id, data.subscription_id),
      currentPeriodEnd: extractPeriodEnd(event),
      eventAt: extractEventAt(event, svixTimestamp),
    });

    return new Response(null, { status: 200 });
  } catch (error) {
    // A 500 asks Svix to retry, which is correct for a transient failure.
    console.error("Failed to apply Clerk webhook", eventType, error);
    return new Response("Failed to apply event", { status: 500 });
  }
});

const http = httpRouter();

http.route({
  path: "/clerk-webhook",
  method: "POST",
  handler: clerkWebhook,
});

export default http;

// Exported for unit testing; not part of the HTTP surface.
export const __testing = {
  verifySvixSignature,
  extractClerkUserId,
  extractPeriodEnd,
  extractPlanKey,
};
