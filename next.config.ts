import type { NextConfig } from "next";
import withSerwistInit from "@serwist/next";

const withSerwist = withSerwistInit({
  swSrc: "app/sw.ts",
  swDest: "public/sw.js",
});

const nextConfig: NextConfig = {
  // Enable React Strict Mode for better debugging
  reactStrictMode: true,

  // Experimental features for Next.js 15
  experimental: {
    // Optimize package imports for better tree-shaking
    optimizePackageImports: [
      "@clerk/nextjs",
      "convex",
    ],
  },

  // No `images` block, deliberately. It allowlisted sleepercdn.com and a.espncdn.com for
  // `next/image`, and nothing in this repository imports `next/image` or references either
  // host — the comments described player photographs the product does not show.
  //
  // An allowlist is not inert. It leaves `/_next/image` willing to fetch and re-encode
  // arbitrary URLs from those hosts for anyone who calls it, which is the surface of the
  // "DoS via Image Optimizer remotePatterns" advisory against the version this was pinned
  // to. Removing it is a smaller change than patching the optimiser and it removes the
  // reachable path rather than narrowing it: with no patterns configured, remote sources
  // are refused outright.
  //
  // Restore it the day a screen actually renders a remote image, with only the hosts that
  // screen uses.

  // PWA configuration
  headers: async () => [
    {
      source: "/(.*)",
      headers: [
        {
          key: "X-Content-Type-Options",
          value: "nosniff",
        },
        {
          key: "X-Frame-Options",
          value: "DENY",
        },
        {
          key: "X-XSS-Protection",
          value: "1; mode=block",
        },
      ],
    },
    {
      source: "/manifest.json",
      headers: [
        {
          key: "Cache-Control",
          value: "public, max-age=31536000, immutable",
        },
      ],
    },
  ],

  // No custom rewrites required for service worker (served from /public)

  // Compiler optimizations
  compiler: {
    // Remove console logs in production
    removeConsole: process.env.NODE_ENV === "production" ? {
      exclude: ["error", "warn"],
    } : false,
  },

  // Performance optimizations
  poweredByHeader: false,
  compress: true,

  // Webpack configuration for additional optimizations
  webpack: (config, { isServer }) => {
    // Optimize bundle size
    if (!isServer) {
      config.resolve.alias = {
        ...config.resolve.alias,
        // Reduce bundle size by using preact in production
        // (uncomment if you want to use preact)
        // "react": "preact/compat",
        // "react-dom": "preact/compat",
      };
    }

    return config;
  },
};

export default withSerwist(nextConfig);
