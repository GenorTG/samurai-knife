import type { NextConfig } from "next";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { knifeHosts } from "./src/lib/hosts";

const nextConfig: NextConfig = {
  // Next blocks its client runtime on unlisted development origins, leaving server HTML inert: list every name the app is
  // opened by (KNIFE_HOST + KNIFE_ALLOWED_HOSTS in .env.local).
  allowedDevOrigins: knifeHosts(),
  // Pin the bundler root to the repo; the home dir has a stray package-lock.json
  // that Turbopack otherwise tries to adopt.
  turbopack: {
    root: path.dirname(fileURLToPath(import.meta.url)),
  },
};

export default nextConfig;
