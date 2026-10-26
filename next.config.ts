import type { NextConfig } from "next";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { knifeHosts } from "./src/lib/hosts";

const nextConfig: NextConfig = {
  // No `X-Powered-By: Next.js`. Security headers are set at runtime by scripts/security-headers.mjs (serve.mjs preload).
  poweredByHeader: false,
  // Next blocks its client runtime on unlisted development origins, leaving server HTML inert: list every name the app is
  // opened by (KNIFE_HOST + KNIFE_ALLOWED_HOSTS in .env.local).
  allowedDevOrigins: knifeHosts(),
  // Pin the bundler root to the repo; the home dir has a stray package-lock.json
  // that Turbopack otherwise tries to adopt.
  turbopack: {
    root: path.dirname(fileURLToPath(import.meta.url)),
  },
  experimental: {
    // Chunk nested async imports in dev the way `next build` already does (its default). With dev's default (off),
    // a next/dynamic component that itself has an import() (CssPlayground -> CodeEditor, WorkflowsTab -> CodeEditor,
    // PdfEditor -> pdfjs-dist) gets a react-loadable-manifest entry naming a chunk dev never emits, so every SSR of
    // that page preloads a 404 (vercel/next.js#99149).
    turbopackClientSideNestedAsyncChunking: true,
  },
};

export default nextConfig;
