import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";

/**
 * Route protection.
 *
 * Only routes that operate on a user's own saved data require an account. Projections and
 * the lineup optimiser are deliberately open: the product's argument is that value should
 * be demonstrated before payment is requested, and the previous version contradicted
 * itself by advertising "try free, no signup" on a button that led straight to a sign-in
 * wall.
 *
 * This is presentation-level routing, not authorisation. Every privileged operation is
 * separately enforced inside Convex, so an unauthenticated request that reaches a
 * protected function still fails.
 */
const isProtectedRoute = createRouteMatcher(["/dashboard(.*)", "/settings(.*)"]);

export default clerkMiddleware(async (auth, request) => {
  if (isProtectedRoute(request)) await auth.protect();
});

export const config = {
  matcher: [
    // Skip Next.js internals and static assets unless referenced in search params.
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    // Always run for API routes.
    "/(api|trpc)(.*)",
  ],
};
