"use client";

import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import { errorText, money2 } from "@/lib/format";

export function EarningsTab() {
  const s = useQuery(api.earnings.summary);
  const cashOut = useMutation(api.earnings.cashOutInstant);
  const [msg, setMsg] = useState("");
  const [error, setError] = useState("");

  if (!s) return <p className="muted">Loading…</p>;
  const max = Math.max(1, ...s.week.map((d) => d.cents));

  async function instant() {
    setError(""); setMsg("");
    try {
      const r = await cashOut({});
      setMsg(`${money2(r.sentCents)} sent to your debit card`);
    } catch (e) { setError(errorText(e)); }
  }

  return (
    <div className="stack" style={{ gap: 18 }}>
      <div className="stack" style={{ gap: 4 }}>
        <span className="eyebrow">Available to cash out</span>
        <div className="big">{money2(s.balanceCents)}</div>
        {s.pendingCrewCents > 0 && <p className="small muted">Plus {money2(s.pendingCrewCents)} of your tips in today&apos;s crew pool. Your share lands when the crew closes.</p>}
      </div>
      {msg && <div className="banner"><span>{msg}</span><span className="demo-tag">Demo</span></div>}
      {error && <p className="error">{error}</p>}
      <div className="stack" style={{ gap: 6 }}>
        <button className="btn primary" disabled={s.balanceCents <= s.instantFeeCents} onClick={instant}>Cash out now · arrives in minutes</button>
        <p className="small muted">Instant fee {money2(s.instantFeeCents)}. Free if you wait for the weekly payout.</p>
      </div>
      <div className="card stack">
        <span className="eyebrow">Last 7 days</span>
        <div className="list">
          {s.week.map((d) => (
            <div className="item" key={d.start}>
              <span style={{ width: 44 }}>{new Date(d.start).toLocaleDateString([], { weekday: "short" })}</span>
              <span className="grow" aria-hidden style={{ height: 8, borderRadius: 4, background: "var(--sunk)", position: "relative" }}>
                <span style={{ position: "absolute", inset: 0, width: `${(d.cents / max) * 100}%`, background: "var(--green)", borderRadius: 4 }} />
              </span>
              <span className="amt" style={{ minWidth: 76, textAlign: "right" }}>{money2(d.cents)}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
