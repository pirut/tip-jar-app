"use client";

import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { RealEarnings } from "@/components/RealEarnings";
import { errorText, money2, time } from "@/lib/format";
import { useDayStart } from "@/lib/useDayStart";

const dayName = (ms: number, weekday: "narrow" | "long") => new Date(ms + 12 * 3600000).toLocaleDateString([], { weekday });

export function EarningsTab() {
  const status = useQuery(api.payments.status);
  if (status === undefined) return <div className="skel" style={{ height: 200 }} aria-busy="true" aria-label="Loading" />;
  return status && status.stage !== "demo" ? <RealEarnings /> : <DemoEarnings />;
}

function DemoEarnings() {
  const dayStart = useDayStart();
  const s = useQuery(api.earnings.summary, { dayStart });
  const cashOut = useMutation(api.earnings.cashOutInstant);
  const [msg, setMsg] = useState("");
  const [error, setError] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  if (!s) return <div className="stack-lg" aria-busy="true" aria-label="Loading"><div className="skel" style={{ width: 180, height: 40 }} /><div className="skel" style={{ height: 200 }} /></div>;
  const max = Math.max(1, ...s.week.map((d) => d.cents));
  const weekCents = s.week.reduce((a, d) => a + d.cents, 0);
  const canCashOut = s.balanceCents > s.instantFeeCents;
  const chartLabel = s.week.map((d) => `${dayName(d.start, "long")} ${money2(d.cents)}`).join(", ");

  async function instant() {
    if (busy) return;
    setError(""); setMsg(""); setBusy(true);
    try {
      const r = await cashOut({});
      setMsg(`${money2(r.sentCents)} would be sent to your debit card. No money moved.`);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  }

  return (
    <div className="stack-lg" style={{ gap: 24, maxWidth: 640 }}>
      <div className="balance-row">
        <div className="stack" style={{ gap: 4 }}>
          <h1 className="stat-head">Available to cash out <span className="demo-tag">Demo</span></h1>
          <div className="amount">{money2(s.balanceCents)}</div>
          <p className="small muted">
            {canCashOut ? `Instant fee ${money2(s.instantFeeCents)}` : `You need more than the ${money2(s.instantFeeCents)} instant fee to cash out`}
          </p>
        </div>
        <button className="btn primary" disabled={!canCashOut} onClick={() => setConfirming(true)}>Cash out now</button>
      </div>
      {s.pendingCrewCents > 0 && <p className="notice">Plus {money2(s.pendingCrewCents)} of your tips in today&apos;s crew pool. Your share lands when the crew closes.</p>}
      {msg && <p className="notice" role="status"><span className="row" style={{ gap: 6, flexWrap: "wrap" }}>{msg}<span className="demo-tag">Demo</span></span></p>}
      {error && <p className="error" role="alert">{error}</p>}

      <section className="section-line stack-lg">
        <div className="row between"><h2 className="t-sub">Last 7 days</h2><span className="strong">{money2(weekCents)}</span></div>
        {weekCents === 0 ? (
          <p className="muted">Your week shows solo tips as they arrive and crew shares after the crew closes.</p>
        ) : (
          <div className="bars" role="img" aria-label={`Earnings by day: ${chartLabel}`}>
            {s.week.map((d, i) => (
              <div className={i === 6 ? "bar today" : "bar"} key={d.start}>
                <span className="bar-amt">{d.cents ? `$${Math.round(d.cents / 100)}` : ""}</span>
                <span className="bar-track"><span className="bar-fill" style={{ height: `${d.cents ? Math.max(4, (d.cents / max) * 100) : 0}%` }} /></span>
                <span className="bar-day">{dayName(d.start, "narrow")}</span>
              </div>
            ))}
          </div>
        )}
      </section>

      {s.cashouts.length > 0 && (
        <section className="section-line">
          <h2 className="t-sub">Cash-outs</h2>
          <div className="list">
            {s.cashouts.map((c) => (
              <div className="item" key={c.at}>
                <div className="stack grow" style={{ gap: 0 }}>
                  <span className="row" style={{ gap: 6 }}>Instant cash-out{c.demo && <span className="demo-tag quiet">Demo</span>}</span>
                  <span className="small muted">{new Date(c.at).toLocaleDateString([], { month: "short", day: "numeric" })}, {time(c.at)}, {money2(c.feeCents)} fee</span>
                </div>
                <span className="item-amt">−{money2(c.amountCents)}</span>
              </div>
            ))}
          </div>
        </section>
      )}

      <ConfirmDialog open={confirming} title={`Cash out ${money2(s.balanceCents)}?`} confirmLabel="Cash out" busyLabel="Working…" cancelLabel="Cancel" busy={busy} onConfirm={instant} onCancel={() => setConfirming(false)}>
        <div className="rows">
          <div className="line"><span>Balance</span><span>{money2(s.balanceCents)}</span></div>
          <div className="line"><span>Instant fee</span><span>−{money2(s.instantFeeCents)}</span></div>
          <div className="line total"><span>You&apos;d get</span><span>{money2(s.balanceCents - s.instantFeeCents)}</span></div>
        </div>
        <p className="small" style={{ marginTop: 12 }}>This is a demo. No money will move.</p>
      </ConfirmDialog>
    </div>
  );
}
