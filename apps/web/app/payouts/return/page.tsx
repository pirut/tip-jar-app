import type { Metadata } from "next";
import Link from "next/link";
import { Logo, SiteFooter } from "@/components/Brand";

export const metadata: Metadata = { title: "Payout setup", robots: { index: false } };

type Props = { searchParams: Promise<{ expired?: string }> };

// Stripe sends workers here from its secure form. It's public because the app may have opened
// that form in a browser with no Tip Jar session, and the worker's status comes from Stripe either way.
export default async function PayoutReturn({ searchParams }: Props) {
  const { expired } = await searchParams;
  return (
    <div className="center-page">
      <header className="site-head"><Logo /></header>
      <main className="center-body">
        <h1 className="t-title">{expired ? "That link expired" : "Back from Stripe"}</h1>
        <p className="muted">
          {expired
            ? "For your security, setup links only work once. Go back to Tip Jar and choose Set up payouts again."
            : "You can close this page and go back to Tip Jar. If Stripe still needs anything, Tip Jar will say so on your Earnings screen."}
        </p>
        <Link className="btn primary" href="/app?tab=earn">Open Earnings</Link>
      </main>
      <SiteFooter />
    </div>
  );
}
