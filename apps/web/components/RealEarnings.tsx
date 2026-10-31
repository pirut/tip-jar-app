"use client";

import { useEffect, useRef, useState } from "react";
import { useAction, useQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import { errorText, money2 } from "@/lib/format";
import { SupportLink } from "./SupportLink";
import { useDayStart } from "@/lib/useDayStart";

const dayName = (ms: number, weekday: "narrow" | "long") => new Date(ms + 12 * 3600000).toLocaleDateString([], { weekday });
const shortDate = (ms: number) => new Date(ms).toLocaleDateString([], { month: "short", day: "numeric" });

const PAYOUT_STATUS: Record<string, string> = {
  paid: "Paid",
  pending: "On the way",
  in_transit: "On the way",
  failed: "Failed",
  canceled: "Canceled",
};

const SETUP_TEXT: Record<string, { title: string; body: string; action?: string }> = {
  setup: { title: "Set up payouts", body: "Tips reach your bank through Stripe, our payments partner. Stripe asks for your identity and bank details on its secure page. Tip Jar never sees them.", action: "Set up payouts" },
  action_needed: { title: "Finish setting up payouts", body: "Stripe needs a bit more from you before you can take tips.", action: "Continue setup" },
  pending: { title: "Stripe is checking your details", body: "Stripe is reviewing your information. No action is needed unless Stripe asks for more details. You can't take tips until the review is complete.", action: "Check or update details" },
  rejected: { title: "Stripe could not approve payouts", body: "You can't take tips through Tip Jar. Contact support for help; repeating setup will not resolve this." },
  frozen: { title: "Your payouts are on hold", body: "A refund or dispute needs attention, so money isn't moving to your account. Contact support." },
  suspended: { title: "Your account is paused", body: "You can't take tips right now. Contact support." },
  paused: { title: "Tips are paused", body: "We've paused tips for now. Money you've already earned is safe." },
};

// What a worker needs to do before they can take real tips. Shown wherever money matters.
export function PayoutSetupCard({ stage }: { stage: string }) {
  const start = useAction(api.paymentsNode.startPayoutSetup);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const text = SETUP_TEXT[stage];
  if (!text) return null;

  async function open() {
    setBusy(true);
    setError("");
    try {
      const { url } = await start({});
      window.location.assign(url);
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  }

  return (
    <section className="notice stack" style={{ gap: 8, textAlign: "left" }}>
      <h2 className="t-sub">{text.title}</h2>
      <p className="small">{text.body}</p>
      <SupportLink />
      {error && <p className="error" role="alert">{error}</p>}
      {text.action && <button className="btn primary" style={{ alignSelf: "flex-start" }} disabled={busy} onClick={open}>{busy ? <><span className="spinner" aria-hidden />Opening Stripe…</> : text.action}</button>}
    </section>
  );
}

export function RealEarnings() {
  const dayStart = useDayStart();
  const r = useQuery(api.earnings.real, { dayStart });
  const refreshBalance = useAction(api.paymentsNode.refreshBalance);
  const refreshStatus = useAction(api.paymentsNode.refreshPayoutStatus);
  const dashboard = useAction(api.paymentsNode.payoutDashboardLink);
  const [error, setError] = useState("");
  const [opening, setOpening] = useState(false);
  const refreshed = useRef(false);

  useEffect(() => {
    if (refreshed.current) return;
    refreshed.current = true;
    // Coming back from Stripe, or just looking: these are Stripe's figures, so ask Stripe.
    refreshStatus({}).then(() => refreshBalance({})).catch(() => { /* The last known figures still show, with their time. */ });
  }, [refreshBalance, refreshStatus]);

  async function openDashboard() {
    setOpening(true);
    setError("");
    try {
      const { url } = await dashboard({});
      window.location.assign(url);
    } catch (e) {
      setError(errorText(e));
      setOpening(false);
    }
  }

  if (!r) return <div className="stack-lg" aria-busy="true" aria-label="Loading"><div className="skel" style={{ width: 180, height: 40 }} /><div className="skel" style={{ height: 200 }} /></div>;
  const max = Math.max(1, ...r.week.map((d) => d.cents));
  const weekCents = r.week.reduce((a, d) => a + d.cents, 0);
  const chartLabel = r.week.map((d) => `${dayName(d.start, "long")} ${money2(d.cents)}`).join(", ");

  // Nothing to show until there's a Stripe account, and a dash for a balance would only confuse.
  if (r.stage === "setup") return <div style={{ maxWidth: 640 }}><PayoutSetupCard stage={r.stage} /></div>;

  return (
    <div className="stack-lg" style={{ gap: 24, maxWidth: 640 }}>
      <PayoutSetupCard stage={r.stage} />
      <div className="balance-row">
        <div className="stack" style={{ gap: 4 }}>
          <h1 className="stat-head">Available in Stripe {r.testMode && <span className="demo-tag">Test</span>}</h1>
          <div className="amount">{r.availableCents === null ? "—" : money2(r.availableCents)}</div>
          <p className="small muted">{r.payoutsPaused ? "Payouts are on hold." : r.payoutsStatus !== "active" ? "Bank payouts are not enabled yet. Check Bank and tax details." : "Pays out to your bank every Monday."}</p>
        </div>
        <button className="btn" disabled={opening} onClick={openDashboard}>{opening ? <><span className="spinner" aria-hidden />Opening…</> : "Bank and tax details"}</button>
      </div>
      {error && <p className="error" role="alert">{error}</p>}

      <div className="rows">
        {r.stripePendingCents !== null && <div className="line"><span>On its way to available</span><span>{money2(r.stripePendingCents)}</span></div>}
        <div className="line"><span>On hold with Tip Jar{r.nextTransferAt && r.onHoldCents > 0 ? `, next release ${shortDate(r.nextTransferAt)}` : ""}</span><span>{money2(r.onHoldCents)}</span></div>
        {r.crewPoolCents > 0 && <div className="line"><span>Your tips in today&apos;s crew pool. Your share comes when it closes</span><span>{money2(r.crewPoolCents)}</span></div>}
        {r.owedCents > 0 && <div className="line"><span>Owed back from a refund or dispute. Comes out of later tips</span><span>−{money2(r.owedCents)}</span></div>}
      </div>
      {r.balanceSyncedAt !== null && <p className="small muted">Stripe figures from {new Date(r.balanceSyncedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}.</p>}

      <section className="section-line stack-lg">
        <div className="row between"><h2 className="t-sub">Last 7 days</h2><span className="strong">{money2(weekCents)}</span></div>
        {weekCents === 0 ? (
          <p className="muted">Your week shows tips as they arrive and crew shares after the crew closes.</p>
        ) : (
          <div className="bars" role="img" aria-label={`Earnings by day: ${chartLabel}`}>
            {r.week.map((d, i) => (
              <div className={i === 6 ? "bar today" : "bar"} key={d.start}>
                <span className="bar-amt">{d.cents ? `$${Math.round(d.cents / 100)}` : ""}</span>
                <span className="bar-track"><span className="bar-fill" style={{ height: `${d.cents ? Math.max(4, (d.cents / max) * 100) : 0}%` }} /></span>
                <span className="bar-day">{dayName(d.start, "narrow")}</span>
              </div>
            ))}
          </div>
        )}
      </section>

      {r.payouts.length > 0 && (
        <section className="section-line">
          <h2 className="t-sub">Payouts to your bank</h2>
          <div className="list">
            {r.payouts.map((p) => (
              <div className="item" key={p.id}>
                <div className="stack grow" style={{ gap: 0 }}>
                  <span>{PAYOUT_STATUS[p.status] ?? p.status}</span>
                  <span className="small muted">{p.status === "failed" ? p.failureMessage ?? "Check your bank details." : `Arrives ${shortDate(p.arrivalDate)}`}</span>
                </div>
                <span className="item-amt">{money2(p.amountCents)}</span>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
