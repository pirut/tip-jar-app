"use client";

import { useState } from "react";
import { useParams } from "next/navigation";
import { useMutation, useQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import { PRESETS_CENTS, feesCents } from "@convex/lib/money";
import { Keypad } from "@/components/Keypad";
import { entryCents, errorText, initials, money, money2, typeKey } from "@/lib/format";

type Receipt = { ticket: string; chargedCents: number; feesCents: number; amountCents: number; covered: boolean };

export default function GuestTipPage() {
  const { handle } = useParams<{ handle: string }>();
  const worker = useQuery(api.workers.byHandle, { handle });
  const tip = useMutation(api.tips.tipFromGuest);

  const [amount, setAmount] = useState<number>(1000);
  const [other, setOther] = useState(false);
  const [entry, setEntry] = useState("");
  const [cover, setCover] = useState(true);
  const [paying, setPaying] = useState(false);
  const [error, setError] = useState("");
  const [receipt, setReceipt] = useState<Receipt | null>(null);

  if (worker === undefined) return <main className="page"><p className="muted">Loading…</p></main>;
  if (worker === null)
    return (
      <main className="page">
        <h2>We couldn&apos;t find that person</h2>
        <p className="muted">Check the QR code or link and try again.</p>
      </main>
    );

  const first = worker.name.split(" ")[0];
  const cents = other ? entryCents(entry) : amount;
  const fees = cents ? feesCents(cents) : 0;
  const total = cents + (cover ? fees : 0);

  async function pay() {
    setError("");
    setPaying(true);
    try {
      const r = await tip({ handle, amountCents: cents, coverFees: cover });
      setReceipt({ ...r, amountCents: cents, covered: cover });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setPaying(false);
    }
  }

  if (receipt)
    return (
      <main className="page">
        <div className="stack grow" style={{ justifyContent: "center", gap: 18 }}>
          <h2>Thanks! {first} got your tip.</h2>
          <div className="ticket">
            <div className="row between">
              <span className="ticket-no">TIP CLAIM № {receipt.ticket}</span>
              <span className="chip">Paid</span>
            </div>
            <div className="big" style={{ marginTop: 10 }}>{money(receipt.amountCents)}</div>
            <p className="small">to {worker.name}{worker.workplace ? ` at ${worker.workplace}` : ""}</p>
            <div className="perf" />
            <div className="row between small"><span>Charged</span><span className="amt">{money2(receipt.chargedCents)}</span></div>
            {receipt.covered && (
              <div className="row between small muted"><span>Fees you covered</span><span className="amt">{money2(receipt.feesCents)}</span></div>
            )}
          </div>
          <p className="small muted center"><span className="demo-tag">Demo</span> No card was charged. Real payments arrive when Stripe is connected.</p>
        </div>
        <button className="btn ghost" style={{ alignSelf: "center" }} onClick={() => { setReceipt(null); setEntry(""); setOther(false); }}>Tip again</button>
      </main>
    );

  return (
    <main className="page">
      <div className="row" style={{ marginTop: 6 }}>
        <div className="avatar lg">{initials(worker.name)}</div>
        <div className="stack" style={{ gap: 4 }}>
          <h2>Tip {first}</h2>
          <p className="muted small">{[worker.jobTitle, worker.workplace].filter(Boolean).join(" · ")}</p>
        </div>
      </div>
      {worker.inCrew && <p className="small muted">{first} shares tips with their crew today.</p>}

      {other ? (
        <div className="stack" style={{ gap: 8 }}>
          <div className="row between">
            <span className="eyebrow">Custom amount</span>
            <button className="btn ghost" onClick={() => setOther(false)}>Back to presets</button>
          </div>
          <div className="big center">{entry ? "$" + entry : "$0"}</div>
          <Keypad onKey={(k) => setEntry((e) => typeKey(e, k))} />
        </div>
      ) : (
        <div className="presets">
          {PRESETS_CENTS.map((c) => (
            <button key={c} className="preset" aria-pressed={amount === c} onClick={() => setAmount(c)}>{money(c)}</button>
          ))}
          <button className="preset other" onClick={() => { setOther(true); setEntry(""); }}>Other</button>
        </div>
      )}

      <div className="toggle">
        <span>Cover the {cents ? money2(fees) : ""} in fees so {first} gets the full {cents ? money(cents) : "tip"}</span>
        <button className="switch" role="switch" aria-label="Cover fees" aria-checked={cover} onClick={() => setCover(!cover)} />
      </div>

      <div className="stack" style={{ marginTop: "auto" }}>
        {error && <p className="error">{error}</p>}
        <button className="btn pay" disabled={!cents || paying} onClick={pay}>
          {paying ? "Paying…" : `Pay ${cents ? money2(total) : ""}`}
        </button>
        <p className="small muted center">No app or account needed. <span className="demo-tag">Demo payments</span></p>
      </div>
    </main>
  );
}
