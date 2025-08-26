const convexAuthConfig = {
  providers: [
    {
      // Use Clerk Issuer Domain from the "convex" JWT template per Convex docs
      // https://docs.convex.dev/auth/clerk#configuring-dev-and-prod-instances
      domain: process.env.CLERK_JWT_ISSUER_DOMAIN,
      applicationID: "convex",
    },
  ],
};

export default convexAuthConfig;