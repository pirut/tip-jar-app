"use client";

import { useAuth } from "@clerk/nextjs";
import { ConvexReactClient } from "convex/react";
import { ConvexProviderWithClerk } from "convex/react-clerk";

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
  return <ConvexProviderWithClerk client={convex} useAuth={useAuth}>{children}</ConvexProviderWithClerk>;
}
