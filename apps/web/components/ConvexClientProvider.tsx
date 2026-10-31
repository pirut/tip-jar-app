"use client";

import { ConvexProvider } from "convex/react";
import { Logo } from "@/components/Brand";
import { convex } from "@/lib/convex";

// Guests never sign in, so Clerk only loads under /app (see WorkerProviders).
export function ConvexClientProvider({ children }: { children: React.ReactNode }) {
  if (!convex) {
    return (
      <div className="center-page">
        <div className="site-head"><Logo /></div>
        <main className="center-body">
          <h1 className="t-title">Tip Jar isn&apos;t available right now</h1>
          <p className="muted">Please try again in a little while.</p>
        </main>
      </div>
    );
  }
  return <ConvexProvider client={convex}>{children}</ConvexProvider>;
}
