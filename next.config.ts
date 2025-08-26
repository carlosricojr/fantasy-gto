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

  // Image optimization configuration
  images: {
    // Use default Next.js image optimization
    remotePatterns: [
      {
        protocol: "https",
        hostname: "sleepercdn.com", // Sleeper player images
      },
      {
        protocol: "https",
        hostname: "a.espncdn.com", // ESPN player images
      },
    ],
    formats: ["image/avif", "image/webp"],
  },

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
