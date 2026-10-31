"use client";

import { useEffect, useRef, useState } from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import { MAX_TIP_CENTS, MIN_TIP_CENTS, PRESETS_CENTS, feesCents } from "@convex/lib/money";
import { LegalLinks, Logo } from "@/components/Brand";
import { DemoBar, TestBar } from "@/components/DemoBar";
import { IconCheck, IconCrew } from "@/components/Icons";
import { Keypad } from "@/components/Keypad";
import { entryCents, errorText, initials, money, money2, typeKey } from "@/lib/format";

type Receipt = { ticket: string; chargedCents: number; feesCents: number; amountCents: number; covered: boolean };
type Worker = { name: string; handle: string; jobTitle: string; workplace: string; inCrew: boolean; payments: "demo" | "real" | "unavailable"; testMode: boolean };

// A worker who can't take tips right now gets no pay button at all, and certainly no demo one.
function GuestUnavailable({ worker }: { worker: Worker }) {
  const first = worker.name.split(" ")[0];
  return (
    <div className="center-page">
      <main className="guest">
        <Logo />
        <div className="stack" style={{ marginBlock: "auto" }}>
          <h1 className="t-title">{first} can&apos;t take tips here right now</h1>
          <p className="muted">Nothing has been charged. You can try this page again later.</p>
        </div>
        <div className="guest-foot"><LegalLinks /></div>
      </main>
    </div>
  );
}

// Back from Stripe. The page only shows what the server has confirmed with Stripe; the address alone proves nothing.
function GuestPaid({ sessionId, worker, onTipAgain }: { sessionId: string; worker: Worker; onTipAgain: () => void }) {
  const receipt = useQuery(api.payments.guestReceipt, { sessionId });
  const refresh = useAction(api.paymentsNode.refreshGuestReceipt);
  const first = worker.name.split(" ")[0];
  const paid = receipt?.status === "succeeded";
  const settled = paid || receipt?.status === "failed" || receipt?.status === "expired" || receipt?.status === "canceled";
  useEffect(() => {
    if (settled) return;
    const check = () => { refresh({ sessionId }).catch(() => { /* The webhook will get there. */ }); };
    check();
    const id = setInterval(check, 4000);
    return () => clearInterval(id);
  }, [settled, sessionId, refresh]);
  return (
    <div className="center-page">
      {worker.testMode && <TestBar />}
      <main className="guest" role="status">
        <Logo />
        <div className="stack-lg rise" style={{ marginBlock: "auto" }}>
          {paid && <div className="thanks-mark"><IconCheck size={26} /></div>}
          <h1 className="t-title">{paid ? `Thanks for tipping ${first}` : settled ? "This tip didn't go through" : "Confirming your tip…"}</h1>
          {!settled && <p className="muted">This usually takes a few seconds.</p>}
          {settled && !paid && <p className="muted">You weren&apos;t charged. You can try again.</p>}
          {paid && receipt && (
            <div className="rows" style={{ marginTop: 8 }}>
              <div className="line"><span>Tip to {worker.name}</span><span>{money2(receipt.tipCents)}</span></div>
              {receipt.coveredFees && <div className="line"><span>Fees you covered</span><span>{money2(receipt.feesCents)}</span></div>}
              {receipt.refundedCents > 0 && <div className="line"><span>Refunded</span><span>−{money2(receipt.refundedCents)}</span></div>}
              <div className="line"><span>Reference</span><span>{receipt.ticket}</span></div>
              <div className="line total"><span>{receipt.testMode ? "Test charge, not real money" : "Charged"}</span><span>{money2(receipt.chargedCents)}</span></div>
            </div>
          )}
        </div>
        <button className="btn full" onClick={onTipAgain}>{paid ? "Tip again" : "Back to tip page"}</button>
        <div className="guest-foot"><LegalLinks /></div>
      </main>
    </div>
  );
}

// One press, one id: a double tap or retry reuses the same payment.
const newRequestId = () => crypto.randomUUID();

export function GuestTip({ handle, worker, paidSession }: { handle: string; worker: Worker; paidSession?: string }) {
  const [returned, setReturned] = useState(paidSession);
  if (worker.payments === "unavailable" && !returned) return <GuestUnavailable worker={worker} />;
  if (returned) return <GuestPaid sessionId={returned} worker={worker} onTipAgain={() => { window.history.replaceState(null, "", `/${handle}`); setReturned(undefined); }} />;
  return <GuestTipForm handle={handle} worker={worker} />;
}

function GuestTipForm({ handle, worker }: { handle: string; worker: Worker }) {
  const tip = useMutation(api.tips.tipFromGuest);
  const checkout = useAction(api.paymentsNode.createGuestCheckout);
  const real = worker.payments === "real";
  const requestId = useRef("");
  const [amount, setAmount] = useState<number>(1000);
  const [other, setOther] = useState(false);
  const [entry, setEntry] = useState("");
  const [cover, setCover] = useState(true);
  const [paying, setPaying] = useState(false);
  const [slow, setSlow] = useState(false);
  const [error, setError] = useState("");
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const slowTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const thanks = useRef<HTMLHeadingElement>(null);
  const receiptKey = `tip-receipt:${handle}`;

  // A reload after paying shows the receipt again, not an armed Pay button.
  useEffect(() => {
    try {
      const saved = sessionStorage.getItem(receiptKey);
      if (saved) setReceipt(JSON.parse(saved));
    } catch { /* Storage can be unavailable; tipping still works for this visit. */ }
  }, [receiptKey]);

  // Screen readers and keyboards land on the confirmation, since the button they pressed is gone.
  useEffect(() => { if (receipt) thanks.current?.focus({ preventScroll: true }); }, [receipt]);

  // Desktop guests can type a custom amount as well as click the keypad.
  useEffect(() => {
    if (!other || receipt || paying) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (/^[0-9.]$/.test(e.key)) setEntry((v) => typeKey(v, e.key));
      else if (e.key === "Backspace") setEntry((v) => typeKey(v, "del"));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [other, receipt, paying]);

  const first = worker.name.split(" ")[0];
  const cents = other ? entryCents(entry) : amount;
  const fees = cents ? feesCents(cents) : 0;
  const total = cents + (cover ? fees : 0);
  const valid = cents >= MIN_TIP_CENTS && cents <= MAX_TIP_CENTS;
  const hint = !cents || valid ? "" : cents < MIN_TIP_CENTS ? `The smallest tip is ${money(MIN_TIP_CENTS)}.` : `The largest tip is ${money(MAX_TIP_CENTS)}.`;
  const subtitle = [worker.jobTitle, worker.workplace].filter(Boolean).join(" at ");

  async function pay() {
    setError("");
    setPaying(true);
    slowTimer.current = setTimeout(() => setSlow(true), 8000);
    try {
      if (real) {
        requestId.current ||= newRequestId();
        const { url } = await checkout({ handle, tipCents: cents, coverFees: cover, clientRequestId: requestId.current });
        window.location.assign(url);
        return; // Stays in its busy state while the browser leaves for Stripe.
      }
      const r = await tip({ handle, amountCents: cents, coverFees: cover });
      const done = { ...r, amountCents: cents, covered: cover };
      setReceipt(done);
      // Storage failure must never turn a recorded tip into a retry prompt.
      try { sessionStorage.setItem(receiptKey, JSON.stringify(done)); } catch { /* Receipt remains in memory. */ }
    } catch (e) {
      setError(errorText(e));
      setPaying(false);
    } finally {
      clearTimeout(slowTimer.current);
      setSlow(false);
      if (!real) setPaying(false);
    }
  }

  // A different amount is a different payment.
  useEffect(() => { requestId.current = ""; }, [cents, cover]);

  function tipAgain() {
    try { sessionStorage.removeItem(receiptKey); } catch { /* Storage may be blocked. */ }
    setReceipt(null);
    setEntry("");
    setOther(false);
  }

  if (receipt)
    return (
      <div className="center-page">
        <DemoBar />
        <main className="guest" role="status">
          <Logo />
          <div className="stack-lg rise" style={{ marginBlock: "auto" }}>
            <div className="thanks-mark"><IconCheck size={26} /></div>
            <h1 className="t-title" ref={thanks} tabIndex={-1} style={{ outline: "none" }}>Thanks for tipping {first}</h1>
            <p className="muted">This was a demo tip, so no card was charged.</p>
            <div className="rows" style={{ marginTop: 8 }}>
              <div className="line"><span>Tip to {worker.name}</span><span>{money2(receipt.amountCents)}</span></div>
              <div className="line">
                <span>{receipt.covered ? "Fees you'd cover" : `Fees from ${first}'s tip`}</span>
                <span>{money2(receipt.feesCents)}</span>
              </div>
              <div className="line"><span>Reference</span><span>{receipt.ticket}</span></div>
              <div className="line total"><span>Would be charged</span><span>{money2(receipt.chargedCents)}</span></div>
            </div>
          </div>
          <button className="btn full" onClick={tipAgain}>Tip again</button>
          <div className="guest-foot"><LegalLinks /></div>
        </main>
      </div>
    );

  return (
    <div className="center-page">
      {!real ? <DemoBar /> : worker.testMode ? <TestBar /> : null}
      <main className="guest">
        <Logo />
        <div>
          <div className="guest-who">
            <div className="grow">
              <h1 className="t-title">Tip {first}</h1>
              {subtitle && <p className="muted" style={{ marginTop: 4 }}>{subtitle}</p>}
            </div>
            <div className="avatar" aria-hidden>{initials(worker.name)}</div>
          </div>
          {worker.inCrew && <p className="guest-crew"><IconCrew size={18} />{first} shares tips with their crew today.</p>}
        </div>

        <div className="stack">
          <span className="label" id="amount-label">Amount</span>
          <div className="presets" role="group" aria-labelledby="amount-label">
            {PRESETS_CENTS.map((c) => (
              <button key={c} className="preset" disabled={paying} aria-pressed={!other && amount === c} onClick={() => { setError(""); setOther(false); setAmount(c); }}>{money(c)}</button>
            ))}
            <button className="preset other" disabled={paying} aria-pressed={other} onClick={() => { setError(""); if (!other) setEntry(""); setOther(true); }}>Other</button>
          </div>
          {other && (
            <div className="stack rise">
              <div className="custom-amount" aria-live="polite">{entry ? "$" + entry : "$0"}</div>
              <Keypad disabled={paying} onKey={(k) => { setError(""); setEntry((e) => typeKey(e, k)); }} />
              {hint && <p className="error center" role="alert">{hint}</p>}
            </div>
          )}
        </div>

        <div>
          <button className="toggle" disabled={paying} role="switch" aria-checked={cover} onClick={() => setCover(!cover)}>
            <span>
              <span className="t-sub" style={{ display: "block" }}>Cover the fees</span>
              <span className="small muted" style={{ display: "block" }}>
                {!valid ? `So ${first} gets the full tip` : cover ? `${first} gets the full ${money(cents)}` : `${first} gets ${money2(cents - fees)} after fees`}
              </span>
            </span>
            <span className="switch" aria-hidden />
          </button>
          <div className="rows" style={{ marginTop: 12 }}>
            <div className="line"><span>Tip</span><span>{money2(valid ? cents : 0)}</span></div>
            {cover && <div className="line"><span>Estimated fees</span><span>{money2(valid ? fees : 0)}</span></div>}
            <div className="line total"><span>Total</span><span>{money2(valid ? total : 0)}</span></div>
          </div>
        </div>

        <div className="guest-pay">
          {error && <p className="error" role="alert">{error}</p>}
          {slow && <p className="error" role="status">Still trying. Check your signal. Your tip hasn&apos;t gone through yet.</p>}
          <button className="btn primary lg full" disabled={!valid || paying} onClick={pay}>
            {paying ? <><span className="spinner" aria-hidden />{real ? "Opening Stripe…" : "Paying…"}</> : valid ? `Pay ${money2(total)}` : "Enter an amount"}
          </button>
          <p className="small muted center">{real ? (worker.testMode ? "Test mode: use a Stripe test card. No real money moves." : "You'll pay on Stripe's secure page. No app or account needed.") : "Demo: no card is charged. No app or account needed."}</p>
        </div>
        <div className="guest-foot"><LegalLinks /></div>
      </main>
    </div>
  );
}
