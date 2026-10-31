"use client";

import { useEffect, useRef, useState } from "react";
import { useMutation } from "convex/react";
import { api } from "@convex/_generated/api";
import { MAX_TIP_CENTS, MIN_TIP_CENTS, PRESETS_CENTS, feesCents } from "@convex/lib/money";
import { DemoBar } from "@/components/DemoBar";
import { Keypad } from "@/components/Keypad";
import { entryCents, errorText, initials, money, money2, typeKey } from "@/lib/format";

type Receipt = { ticket: string; chargedCents: number; feesCents: number; amountCents: number; covered: boolean };
type Worker = { name: string; jobTitle: string; workplace: string; inCrew: boolean };

export function GuestTip({ handle, worker }: { handle: string; worker: Worker }) {
  const tip = useMutation(api.tips.tipFromGuest);
  const [amount, setAmount] = useState<number>(1000);
  const [other, setOther] = useState(false);
  const [entry, setEntry] = useState("");
  const [cover, setCover] = useState(true);
  const [paying, setPaying] = useState(false);
  const [slow, setSlow] = useState(false);
  const [error, setError] = useState("");
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const slowTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const receiptKey = `tip-receipt:${handle}`;

  // A reload after paying shows the receipt again, not an armed Pay button.
  useEffect(() => {
    const saved = sessionStorage.getItem(receiptKey);
    if (saved) setReceipt(JSON.parse(saved));
  }, [receiptKey]);

  const first = worker.name.split(" ")[0];
  const cents = other ? entryCents(entry) : amount;
  const fees = cents ? feesCents(cents) : 0;
  const total = cents + (cover ? fees : 0);
  const valid = cents >= MIN_TIP_CENTS && cents <= MAX_TIP_CENTS;
  const hint = !cents || valid ? "" : cents < MIN_TIP_CENTS ? `The smallest tip is ${money(MIN_TIP_CENTS)}.` : `The largest tip is ${money(MAX_TIP_CENTS)}.`;

  async function pay() {
    setError("");
    setPaying(true);
    slowTimer.current = setTimeout(() => setSlow(true), 8000);
    try {
      const r = await tip({ handle, amountCents: cents, coverFees: cover });
      const done = { ...r, amountCents: cents, covered: cover };
      sessionStorage.setItem(receiptKey, JSON.stringify(done));
      setReceipt(done);
    } catch (e) {
      setError(errorText(e));
    } finally {
      clearTimeout(slowTimer.current);
      setSlow(false);
      setPaying(false);
    }
  }

  function tipAgain() {
    sessionStorage.removeItem(receiptKey);
    setReceipt(null);
    setEntry("");
    setOther(false);
  }

  if (receipt)
    return (
      <>
        <DemoBar />
        <main className="page">
          <div className="stack grow" style={{ justifyContent: "center", gap: 18 }} role="status">
            <div className="thanks-head">
              <div className="avatar lg">{initials(worker.name)}<span className="check" aria-hidden>✓</span></div>
              <h2>Thanks for tipping {first}!</h2>
            </div>
            <div className="ticket rise">
              <div className="row between">
                <span className="ticket-no">TIP CLAIM № {receipt.ticket}</span>
                <span className="demo-tag">Demo</span>
              </div>
              <div className="big" style={{ marginTop: 10 }}>{money(receipt.amountCents)}</div>
              <p className="small">to {worker.name}{worker.workplace ? ` at ${worker.workplace}` : ""}</p>
              <div className="perf" />
              <div className="row between small"><span>Would charge</span><span className="amt">{money2(receipt.chargedCents)}</span></div>
              {receipt.covered && (
                <div className="row between small"><span>Fees you&apos;d cover</span><span className="amt">{money2(receipt.feesCents)}</span></div>
              )}
            </div>
            <p className="small muted center">No card was charged. Real payments arrive when Stripe is connected.</p>
          </div>
          <button className="btn ghost" style={{ alignSelf: "center" }} onClick={tipAgain}>Tip again</button>
        </main>
      </>
    );

  return (
    <>
      <DemoBar />
      <main className="page">
        <span className="wordmark small-mark">Tip Jar</span>
        <div className="row">
          <div className="avatar lg">{initials(worker.name)}</div>
          <div className="stack" style={{ gap: 4, minWidth: 0 }}>
            <h1 className="h2">Tip {first}</h1>
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
            <div className="big center" aria-live="polite">{entry ? "$" + entry : "$0"}</div>
            <Keypad onKey={(k) => { setError(""); setEntry((e) => typeKey(e, k)); }} />
            {hint && <p className="error center" role="alert">{hint}</p>}
          </div>
        ) : (
          <div className="presets">
            {PRESETS_CENTS.map((c) => (
              <button key={c} className="preset" aria-pressed={amount === c} onClick={() => { setError(""); setAmount(c); }}>{money(c)}</button>
            ))}
            <button className="preset other" onClick={() => { setError(""); setOther(true); setEntry(""); }}>Other</button>
          </div>
        )}

        <button className="toggle" role="switch" aria-checked={cover} onClick={() => setCover(!cover)}>
          <span>
            {!valid
              ? `Cover the fees so ${first} gets the full tip`
              : cover
                ? `Covering the ${money2(fees)} in fees so ${first} gets the full ${money(cents)}`
                : `${first} gets ${money2(cents - fees)} after ${money2(fees)} in fees. Tap to cover them.`}
          </span>
          <span className="switch" aria-hidden />
        </button>

        <div className="stack" style={{ marginTop: "auto" }}>
          {error && <p className="error" role="alert">{error}</p>}
          {slow && <p className="error" role="status">Still trying. Check your signal. Your tip hasn&apos;t gone through yet.</p>}
          <button className="btn pay" disabled={!valid || paying} onClick={pay}>
            {paying ? <><span className="spinner" aria-hidden /> Paying…</> : valid ? `Pay ${money2(total)}` : "Choose an amount"}
          </button>
          <p className="small muted center">No app or account needed.</p>
        </div>
      </main>
    </>
  );
}
