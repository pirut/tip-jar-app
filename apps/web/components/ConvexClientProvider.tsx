"use client";

import { ConvexAuthProvider } from "@convex-dev/auth/react";
import { ConvexReactClient } from "convex/react";

const url = process.env.NEXT_PUBLIC_CONVEX_URL;
const convex = url ? new ConvexReactClient(url) : null;

export function ConvexClientProvider({ children }: { children: React.ReactNode }) {
  if (!convex) {
    return (
      <main className="page">
        <h2>Tip Jar isn&apos;t connected yet</h2>
        <p className="muted">NEXT_PUBLIC_CONVEX_URL is missing. Deploy the Convex backend and set it.</p>
      </main>
    );
  }
  return <ConvexAuthProvider client={convex}>{children}</ConvexAuthProvider>;
}
