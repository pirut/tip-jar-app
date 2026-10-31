"use client";

import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { QRCodeSVG } from "qrcode.react";
import { api } from "@convex/_generated/api";
import type { SplitMode } from "@convex/lib/split";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { IconCheck, IconCopy } from "@/components/Icons";
import { errorText, initials, money2, time } from "@/lib/format";

const MODES: [SplitMode, string][] = [["even", "Even"], ["hours", "Hours"], ["shares", "Shares"], ["custom", "Custom %"]];
const MODE_NAME: Record<SplitMode, string> = { even: "split evenly", hours: "split by hours", shares: "split by shares", custom: "split by custom percents" };
const MODE_HELP: Record<SplitMode, string> = {
  even: "Same amount for everyone.",
  hours: "Based on time each person has been in the crew.",
  shares: "Weighted by role, like lead 1.5, valet 1, runner 0.5.",
  custom: "A fixed percent per person. Must add up to 100.",
};
// Mirrors effectiveWeights in convex/lib/split.ts: a crew that closes on its own never loses the pool.
const CUSTOM_FALLBACK = "If percents don't add up to 100% when the crew closes on its own, the pool splits evenly.";

type Run = (fn: () => Promise<unknown>) => Promise<void>;

function useRun(): { error: string; busy: boolean; run: Run; setError: (e: string) => void } {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const run: Run = async (fn) => {
    if (inFlight.current) return; // a double tap must not fire the action twice
    inFlight.current = true;
    setError("");
    setBusy(true);
    try { await fn(); } catch (e) { setError(errorText(e)); } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  return { error, busy, run, setError };
}

export function CrewTab() {
  const data = useQuery(api.crews.current);
  const last = useQuery(api.crews.lastClosed);
  if (data === undefined) return <div className="stack-lg" aria-busy="true" aria-label="Loading"><div className="skel" style={{ width: "50%", height: 28 }} /><div className="skel" style={{ height: 200 }} /></div>;
  if (!data?.crew) return <NoCrew last={last ?? null} leftCrew={data?.leftCrew ?? null} />;
  return <InCrew crew={data.crew} />;
}

type Preview = { name: string; splitMode: SplitMode; closesAt: number; starterName: string; memberCount: number };

function NoCrew({ last, leftCrew }: { last: { name: string; myPayoutCents: number; real: boolean; rows: { name: string; payoutCents: number }[] } | null; leftCrew: { name: string; closesAt: number } | null }) {
  const start = useMutation(api.crews.start);
  const join = useMutation(api.crews.join);
  const lookup = useMutation(api.crews.lookup);
  const joinForm = useRun();
  const startForm = useRun();
  const [code, setCode] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [name, setName] = useState("");
  const [mode, setMode] = useState<SplitMode>("even");
  const [hours, setHours] = useState(8);
  const hoursValid = hours > 0 && hours <= 24;

  // A scanned crew QR opens /app?join=1234.
  useEffect(() => {
    const c = new URLSearchParams(window.location.search).get("join");
    if (c && /^\d{4}$/.test(c)) setCode(c);
  }, []);

  const check = () => joinForm.run(async () => {
    const r = await lookup({ code });
    if (r.ok) setPreview(r.crew);
    else joinForm.setError(r.error);
  });
  const confirm = () => joinForm.run(async () => {
    const r = await join({ code });
    if (r.ok) window.history.replaceState(null, "", "/app?tab=crew");
    else { setPreview(null); joinForm.setError(r.error); }
  });

  return (
    <div className="stack-lg" style={{ gap: 24 }}>
      <div className="stack" style={{ gap: 4, maxWidth: 560 }}>
        <h1 className="t-page">Pool tips with today&apos;s crew</h1>
        <p className="muted">Tips you get while in a crew go into one pool, split when the crew closes. Tips from before you join stay yours.</p>
      </div>

      {leftCrew && <p className="notice" role="status">You left {leftCrew.name}. Your share lands when it closes at {time(leftCrew.closesAt)}. Rejoin any time with the code.</p>}

      <div className="two-up">
        <section className="stack-lg">
          {preview ? (
            <>
              <div className="stack" style={{ gap: 4 }}>
                <h2 className="t-page">Join {preview.name}?</h2>
                <p className="muted">Started by {preview.starterName}, {preview.memberCount} {preview.memberCount === 1 ? "person" : "people"}</p>
              </div>
              <div className="rows">
                <div className="line"><span>Tips are</span><span>{MODE_NAME[preview.splitMode]}</span></div>
                <div className="line"><span>Closes at</span><span>{time(preview.closesAt)}</span></div>
              </div>
              <p className="small muted">Your tips go to the pool from now on.{preview.splitMode === "custom" ? ` ${CUSTOM_FALLBACK}` : ""}</p>
              {joinForm.error && <p className="error" role="alert">{joinForm.error}</p>}
              <div className="row wrap">
                <button className="btn primary" disabled={joinForm.busy} onClick={confirm}>{joinForm.busy ? <><span className="spinner" aria-hidden />Joining…</> : "Join crew"}</button>
                <button className="btn ghost" onClick={() => setPreview(null)}>Not this one</button>
              </div>
            </>
          ) : (
            <form className="stack-lg" onSubmit={(e) => { e.preventDefault(); if (code.length === 4) check(); }}>
              <h2 className="t-sub">Join a crew</h2>
              <div className="field">
                <label htmlFor="code">4-digit crew code</label>
                <input id="code" className="input code-in" inputMode="numeric" autoComplete="off" maxLength={4} placeholder="····" aria-invalid={!!joinForm.error} value={code} onChange={(e) => { joinForm.setError(""); setCode(e.target.value.replace(/\D/g, "")); }} />
                {joinForm.error && <p className="error" role="alert">{joinForm.error}</p>}
              </div>
              <button className="btn primary" style={{ alignSelf: "flex-start" }} disabled={code.length !== 4 || joinForm.busy}>{joinForm.busy ? <><span className="spinner" aria-hidden />Checking…</> : "Continue"}</button>
            </form>
          )}
        </section>

        <form className="stack-lg" onSubmit={(e) => { e.preventDefault(); if (hoursValid) startForm.run(() => start({ name, splitMode: mode, closesInHours: hours })); }}>
          <h2 className="t-sub">Start a crew</h2>
          <div className="field"><label htmlFor="crew-name">Crew name</label><input id="crew-name" className="input" maxLength={60} required value={name} onChange={(e) => setName(e.target.value)} placeholder="Harbor valet, Friday" /></div>
          <fieldset className="field">
            <legend>How to split</legend>
            <div className="seg">{MODES.map(([k, l]) => <button type="button" key={k} aria-pressed={mode === k} onClick={() => setMode(k)}>{l}</button>)}</div>
            <p className="small muted">{MODE_HELP[mode]} Only you can change this.{mode === "custom" ? ` ${CUSTOM_FALLBACK}` : ""}</p>
          </fieldset>
          <div className="field">
            <label htmlFor="crew-hours">Closes after (hours)</label>
            <input id="crew-hours" className="input" style={{ maxWidth: 120 }} type="number" inputMode="numeric" min={1} max={24} aria-invalid={!hoursValid} value={Number.isNaN(hours) ? "" : hours} onChange={(e) => setHours(e.target.valueAsNumber)} />
            {!hoursValid && <p className="error small">Enter 1 to 24 hours.</p>}
          </div>
          {startForm.error && <p className="error" role="alert">{startForm.error}</p>}
          <button className="btn primary" style={{ alignSelf: "flex-start" }} disabled={startForm.busy || !hoursValid}>{startForm.busy ? <><span className="spinner" aria-hidden />Starting…</> : "Start crew"}</button>
        </form>
      </div>

      {last && (
        <section className="section-line stack" style={{ maxWidth: 560 }}>
          <div className="row between"><h2 className="t-sub">Last crew: {last.name}</h2>{!last.real && <span className="demo-tag">Demo</span>}</div>
          <div className="rows">
            {last.rows.map((r, i) => <div className="line" key={i}><span>{r.name}</span><span>{money2(r.payoutCents)}</span></div>)}
            <div className="line total"><span>Your share</span><span>{money2(last.myPayoutCents)}</span></div>
          </div>
        </section>
      )}
    </div>
  );
}

// Keeps what's being typed while the field has focus, then follows the live value again.
function NumberField({ value, label, step, onCommit }: { value: number; label: string; step: number; onCommit: (n: number) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <input
      className="num-in"
      type="number"
      inputMode="decimal"
      step={step}
      min={0}
      aria-label={label}
      value={draft ?? value}
      onFocus={() => setDraft(String(value))}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        if (draft !== null && draft !== "" && Number(draft) !== value) onCommit(Number(draft));
        setDraft(null);
      }}
    />
  );
}

type CrewData = NonNullable<NonNullable<ReturnType<typeof useQuery<typeof api.crews.current>>>["crew"]>;

function InCrew({ crew }: { crew: CrewData }) {
  const setSplitMode = useMutation(api.crews.setSplitMode);
  const setWeights = useMutation(api.crews.setMemberWeights);
  const close = useMutation(api.crews.close);
  const leave = useMutation(api.crews.leave);
  const removeMember = useMutation(api.crews.removeMember);
  const { error, busy, run } = useRun();
  const [confirming, setConfirming] = useState<"close" | "leave" | null>(null);
  const [removing, setRemoving] = useState<CrewData["members"][number] | null>(null);
  const [showQr, setShowQr] = useState(false);
  const [changedTo, setChangedTo] = useState<SplitMode | null>(null);
  const [origin, setOrigin] = useState("");
  const [copied, setCopied] = useState(false);
  useEffect(() => setOrigin(window.location.origin), []);
  const mode = crew.splitMode as SplitMode;
  const pctTotal = crew.members.reduce((a, m) => a + m.pct, 0);
  const activeCount = crew.members.filter((m) => !m.left).length;
  const field = mode === "hours" ? "hours" : mode === "shares" ? "shares" : mode === "custom" ? "pct" : null;

  // Members hear about split changes; only the starter can make them.
  const seenMode = useRef(mode);
  useEffect(() => {
    if (seenMode.current !== mode && !crew.iAmStarter) setChangedTo(mode);
    seenMode.current = mode;
  }, [mode, crew.iAmStarter]);

  async function copyCode() {
    try {
      await navigator.clipboard.writeText(crew.code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* the code is on screen to read out */
    }
  }

  return (
    <div className="stack-lg" style={{ gap: 24, maxWidth: 640 }}>
      <div className="crew-head">
        <div className="stack" style={{ gap: 4 }}>
          <h1 className="stat-head">{crew.name} {!crew.real && <span className="demo-tag">Demo</span>}</h1>
          <div className="amount">{money2(crew.poolCents)}</div>
          <p className="small muted">In the pool, {activeCount} {activeCount === 1 ? "person" : "people"}, closes at {time(crew.closesAt)}</p>
        </div>
        <div className="stack" style={{ gap: 4 }}>
          <span className="small muted">Join code</span>
          <div className="row">
            <span className="join-code">{crew.code}</span>
            <button className="btn" style={{ paddingInline: 12 }} onClick={copyCode}>{copied ? <IconCheck size={18} /> : <IconCopy size={18} />}{copied ? "Copied" : "Copy"}</button>
            <button className="btn" style={{ paddingInline: 12 }} aria-expanded={showQr} onClick={() => setShowQr(!showQr)}>QR</button>
          </div>
        </div>
      </div>
      {showQr && origin && <div className="crew-qr"><div className="qr"><QRCodeSVG value={`${origin}/app?join=${crew.code}`} size={168} title={`QR code to join with code ${crew.code}`} /></div></div>}

      {changedTo && <p className="notice" role="status"><span>The crew starter changed the split: tips are now {MODE_NAME[changedTo]}.</span><button className="btn" onClick={() => setChangedTo(null)}>OK</button></p>}

      <section className="stack">
        <h2 className="t-sub">{crew.iAmStarter ? "How to split" : `Tips are ${MODE_NAME[mode]}`}</h2>
        {crew.iAmStarter && (
          <div className="seg" role="group" aria-label="How to split">
            {MODES.map(([k, l]) => <button key={k} aria-pressed={mode === k} onClick={() => run(() => setSplitMode({ splitMode: k }))}>{l}</button>)}
          </div>
        )}
        {!crew.splitValid ? (
          crew.iAmStarter
            ? <p className="error small" role="alert">Percents add to {pctTotal}%. They need to add to 100%. If they don&apos;t by {time(crew.closesAt)}, the pool splits evenly.</p>
            : <p className="small muted">The crew starter is setting percents. If they don&apos;t add to 100% by {time(crew.closesAt)}, the pool splits evenly.</p>
        ) : crew.evenFallback ? (
          <p className="small muted">{mode === "hours" ? "Hours are still at zero, so for now this splits evenly." : "All weights are zero, so this splits evenly."}</p>
        ) : (
          <p className="small muted">{MODE_HELP[mode]} {crew.iAmStarter ? "Only you can change this." : "Only the person who started the crew can change this."}</p>
        )}
      </section>

      <section>
        <div className="member-cols">
          <h2 className="t-sub">People</h2>
          <span>
            {field && <span className="c1">{field === "pct" ? "Percent" : field === "hours" ? "Hours" : "Shares"}</span>}
            <span className="c2">Est. share</span>
          </span>
        </div>
        <div className="list">
          {crew.members.map((m) => (
            <div className="member" key={m.memberId}>
              <div className="avatar sm" aria-hidden>{initials(m.name)}</div>
              <div className="stack" style={{ gap: 0, minWidth: 0 }}>
                <span style={{ overflowWrap: "anywhere" }}>{m.name}{m.isMe ? " (you)" : ""}</span>
                <span className="small muted">{[m.jobTitle, m.isStarter ? "started crew" : "", m.left ? "left, share pending" : ""].filter(Boolean).join(", ")}</span>
                {crew.iAmStarter && !m.isMe && <button className="text-btn" onClick={() => setRemoving(m)} aria-label={`Remove ${m.name} from crew`}>Remove</button>}
              </div>
              <div className="member-right">
                {field && (crew.iAmStarter ? (
                  <NumberField
                    value={m[field]}
                    step={field === "pct" ? 1 : 0.25}
                    label={`${field === "pct" ? "Percent" : field === "hours" ? "Hours" : "Shares"} for ${m.name}`}
                    onCommit={(n) => run(() => setWeights({ memberId: m.memberId, [field]: n }))}
                  />
                ) : (
                  <span className="small muted">{m[field]}{field === "pct" ? "%" : field === "hours" ? "h" : "×"}</span>
                ))}
                <span className="member-amt">{m.projectedCents === null ? "—" : money2(m.projectedCents)}</span>
              </div>
            </div>
          ))}
        </div>
      </section>
      {error && <p className="error" role="alert">{error}</p>}

      {crew.iAmStarter ? (
        <div className="stack section-line">
          <button className="btn primary" style={{ alignSelf: "flex-start" }} disabled={!crew.splitValid} onClick={() => setConfirming("close")}>Close crew and split now</button>
          {!crew.splitValid && <p className="small muted">Fix the percents before closing early.</p>}
        </div>
      ) : (
        <button className="btn" style={{ alignSelf: "flex-start" }} onClick={() => setConfirming("leave")}>Leave crew</button>
      )}

      <ConfirmDialog open={confirming === "close"} title="Close the crew?" confirmLabel="Close and split" busyLabel="Closing…" cancelLabel="Keep crew open" busy={busy} onConfirm={() => run(() => close({})).then(() => setConfirming(null))} onCancel={() => setConfirming(null)}>
        Everyone gets their share of the {money2(crew.poolCents)} pool now. This can&apos;t be undone.
      </ConfirmDialog>
      <ConfirmDialog open={confirming === "leave"} title="Leave this crew?" confirmLabel="Leave crew" busyLabel="Leaving…" cancelLabel="Stay" busy={busy} onConfirm={() => run(() => leave({})).then(() => setConfirming(null))} onCancel={() => setConfirming(null)}>
        You still get your share when it closes, and new tips stay yours.
      </ConfirmDialog>
      <ConfirmDialog open={removing !== null} title={`Remove ${removing?.name.split(" ")[0] ?? ""}?`} confirmLabel="Remove" busyLabel="Removing…" cancelLabel="Keep" danger busy={busy} onConfirm={() => { const id = removing!.memberId; run(() => removeMember({ memberId: id })).then(() => setRemoving(null)); }} onCancel={() => setRemoving(null)}>
        Their tips go back to them, and they won&apos;t be able to rejoin this crew.
      </ConfirmDialog>
    </div>
  );
}
