"use client";

import { ConvexProvider } from "convex/react";
import { convex } from "@/lib/convex";

// Guests never sign in, so Clerk only loads under /app (see WorkerProviders).
export function ConvexClientProvider({ children }: { children: React.ReactNode }) {
  if (!convex) {
    return (
      <main className="page">
        <h2>Tip Jar isn&apos;t connected yet</h2>
        <p className="muted">NEXT_PUBLIC_CONVEX_URL is missing. Deploy the Convex backend and set it.</p>
      </main>
    );
  }
  return <ConvexProvider client={convex}>{children}</ConvexProvider>;
}
