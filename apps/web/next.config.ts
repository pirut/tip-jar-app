import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  // The Convex backend lives at the repo root, outside this app.
  outputFileTracingRoot: path.join(__dirname, "../.."),
  experimental: { externalDir: true },
  devIndicators: false,
};

export default nextConfig;
