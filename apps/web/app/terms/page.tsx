import type { Metadata } from "next";
import { Logo, SiteFooter } from "@/components/Brand";

export const metadata: Metadata = { title: "Terms" };

export default function Terms() {
  return (
    <div className="center-page">
      <header className="site-head"><Logo /></header>
      <main className="prose" style={{ flex: 1, width: "100%" }}>
        <h1 className="t-title">Terms</h1>
        <p className="small muted">Draft pending legal review. Nothing here is legal or tax advice.</p>
        <h2>Demo and pilot</h2>
        <p>Most Tip Jar accounts are in a demo: payments and cash-outs are simulated, no card is charged, no money moves, and those balances have no cash value. They&apos;re marked Demo.</p>
        <p>Workers we&apos;ve invited to our pilot take real tips. Anything marked Test uses Stripe&apos;s test system and isn&apos;t real money either.</p>
        <h2>Using Tip Jar</h2>
        <p>Tip Jar is for people in the US who receive tips for their work. Use your real name, keep your account secure, and don&apos;t use the app to mislead guests or coworkers. Tips only: Tip Jar doesn&apos;t handle wages.</p>
        <h2>Tips and fees</h2>
        <p>Guests see the tip, the fees and the total before paying. If a guest covers the fees, the worker receives the full tip. If not, the fees come out of the tip. Fees are an estimate of card processing plus a 25¢ Tip Jar fee, and may differ slightly from what Stripe charges us.</p>
        <p>Payments are processed by Stripe. Tip Jar is the seller on the guest&apos;s card statement. For refunds, contact us. Refunds are at our discretion and may be required by card network rules.</p>
        <h2>Getting paid</h2>
        <p>To receive real tips you agree to the Stripe Connected Account Agreement and complete Stripe&apos;s identity and bank checks. A tip stays in Tip Jar&apos;s Stripe account for a holding period, currently about a day, before it moves to your Stripe account. Stripe then pays out to your bank on a schedule, currently weekly. This is not an escrow or a bank account, and it earns no interest.</p>
        <p><b>Refunds and disputes.</b> If a guest gets a refund or wins a card dispute, we take the matching amount back from what you and your crew received, including by reducing later tips. We may pause transfers or payouts while something is being investigated.</p>
        <p><b>Taxes.</b> Tips are taxable income, and you&apos;re responsible for reporting them. Stripe may send you tax forms. If you&apos;re an employee, your employer may also have to report your tips. Check with a tax adviser.</p>
        <h2>Crews</h2>
        <p>The person who starts a crew chooses how it splits and can remove members. Shares shown before a crew closes are estimates. Tip-pooling rules, including limits on managers and supervisors sharing tips, vary by employer and state, and following them is up to you and your employer.</p>
      </main>
      <SiteFooter />
    </div>
  );
}
