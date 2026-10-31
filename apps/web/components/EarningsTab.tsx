"use client";

import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import { errorText, money2, time } from "@/lib/format";
import { useDayStart } from "@/lib/useDayStart";

export function EarningsTab() {
  const dayStart = useDayStart();
  const s = useQuery(api.earnings.summary, { dayStart });
  const cashOut = useMutation(api.earnings.cashOutInstant);
  const [msg, setMsg] = useState("");
  const [error, setError] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  if (!s) return <div className="stack" aria-busy="true"><div className="skel big-line" /><div className="skel tall" /></div>;
  const max = Math.max(1, ...s.week.map((d) => d.cents));
  const weekCents = s.week.reduce((a, d) => a + d.cents, 0);
  const canCashOut = s.balanceCents > s.instantFeeCents;

  async function instant() {
    if (busy) return;
    setError(""); setMsg(""); setBusy(true);
    try {
      const r = await cashOut({});
      setMsg(`${money2(r.sentCents)} would be sent to your debit card`);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  }

  return (
    <div className="stack" style={{ gap: 18 }}>
      <div className="stack" style={{ gap: 4 }}>
        <span className="eyebrow">Available to cash out <span className="demo-tag">Demo</span></span>
        <div className="big">{money2(s.balanceCents)}</div>
        {s.pendingCrewCents > 0 && <p className="small muted">Plus {money2(s.pendingCrewCents)} of your tips in today&apos;s crew pool. Your share lands when the crew closes.</p>}
      </div>
      {msg && <div className="banner" role="status"><span>{msg}</span><span className="demo-tag">Demo</span></div>}
      {error && <p className="error" role="alert">{error}</p>}
      {confirming ? (
        <div className="banner">
          <span>Cash out {money2(s.balanceCents)}? The instant fee is {money2(s.instantFeeCents)}, so you&apos;d get {money2(s.balanceCents - s.instantFeeCents)}.</span>
          <span className="row">
            <button className="btn small" onClick={() => setConfirming(false)}>Cancel</button>
            <button className="btn small primary" disabled={busy} onClick={instant}>{busy ? "Working…" : "Cash out"}</button>
          </span>
        </div>
      ) : (
        <div className="stack" style={{ gap: 6 }}>
          <button className="btn primary" disabled={!canCashOut} onClick={() => setConfirming(true)}>Cash out now</button>
          <p className="small muted">
            {canCashOut ? `Instant fee ${money2(s.instantFeeCents)}.` : `You need more than the ${money2(s.instantFeeCents)} instant fee to cash out.`}
          </p>
        </div>
      )}
      <div className="card stack">
        <div className="row between"><span className="eyebrow">Last 7 days</span><span className="mid">{money2(weekCents)}</span></div>
        {weekCents === 0 ? (
          <p className="small muted">Your week fills in as tips arrive.</p>
        ) : (
          <div className="bars" role="img" aria-label={`Earnings by day, ${money2(weekCents)} in total`}>
            {s.week.map((d, i) => (
              <div className={i === 6 ? "bar today" : "bar"} key={d.start}>
                <span className="small amt-mini">{d.cents ? money2(d.cents).replace(/\.00$/, "") : ""}</span>
                <span className="bar-track"><span className="bar-fill" style={{ height: `${Math.max(d.cents ? 6 : 0, (d.cents / max) * 100)}%` }} /></span>
                <span className="small muted">{new Date(d.start + 12 * 3600000).toLocaleDateString([], { weekday: "narrow" })}</span>
              </div>
            ))}
          </div>
        )}
      </div>
      {s.cashouts.length > 0 && (
        <div className="stack" style={{ gap: 2 }}>
          <span className="eyebrow">Cash-outs</span>
          <div className="list">
            {s.cashouts.map((c) => (
              <div className="item" key={c.at}>
                <div className="stack" style={{ gap: 0 }}>
                  <span>Instant cash-out {c.demo && <span className="demo-tag">Demo</span>}</span>
                  <span className="small muted">{new Date(c.at).toLocaleDateString([], { month: "short", day: "numeric" })}, {time(c.at)} · {money2(c.feeCents)} fee</span>
                </div>
                <span className="amt">−{money2(c.amountCents)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
