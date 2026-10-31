import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = { title: "Terms" };

export default function Terms() {
  return (
    <main className="page prose">
      <Link className="wordmark" href="/">Tip Jar</Link>
      <h1>Terms</h1>
      <p className="small muted">Draft for the demo period, pending legal review.</p>
      <h2>This is a demo</h2>
      <p>Tip Jar is in a demo period. Payments, Tap to Pay and cash-outs are simulated. No card is charged and no money moves. Balances shown in the app have no cash value.</p>
      <h2>Using Tip Jar</h2>
      <p>Tip Jar is for people in the US who receive tips for their work. Use your real name, keep your account secure, and don&apos;t use the app to mislead guests or coworkers.</p>
      <h2>Crews</h2>
      <p>The person who starts a crew chooses how it splits and can remove members. Shares shown before a crew closes are estimates.</p>
    </main>
  );
}
