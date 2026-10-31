"use client";

import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { QRCodeSVG } from "qrcode.react";
import { api } from "@convex/_generated/api";
import type { SplitMode } from "@convex/lib/split";
import { errorText, initials, money2, time } from "@/lib/format";

const MODES: [SplitMode, string][] = [["even", "Even"], ["hours", "Hours"], ["shares", "Shares"], ["custom", "Custom %"]];
const MODE_NAME: Record<SplitMode, string> = { even: "split evenly", hours: "split by hours", shares: "split by shares", custom: "split by custom percents" };
const MODE_HELP: Record<SplitMode, string> = {
  even: "Same amount for everyone.",
  hours: "Based on time each person has been in the crew.",
  shares: "Weighted by role, like lead 1.5, valet 1, runner 0.5.",
  custom: "A fixed percent per person. Must add up to 100.",
};

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
  if (data === undefined) return <div className="stack" aria-busy="true"><div className="skel tall" /></div>;
  if (!data?.crew) return <NoCrew last={last ?? null} leftCrew={data?.leftCrew ?? null} />;
  return <InCrew crew={data.crew} />;
}

type Preview = { name: string; splitMode: SplitMode; closesAt: number; starterName: string; memberCount: number };

function NoCrew({ last, leftCrew }: { last: { name: string; myPayoutCents: number; rows: { name: string; payoutCents: number }[] } | null; leftCrew: { name: string; closesAt: number } | null }) {
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
  const [starting, setStarting] = useState(false);

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
    <div className="stack" style={{ gap: 16 }}>
      <span className="eyebrow">Today&apos;s crew</span>
      <h2>Pool tips with who you&apos;re working with</h2>
      <p className="muted">Tips you get while in a crew go into one pool, split when the crew closes. Tips from before you join stay yours.</p>

      {leftCrew && <div className="banner" role="status"><span>You left {leftCrew.name}. Your share lands when it closes at {time(leftCrew.closesAt)}. Rejoin any time with the code.</span></div>}

      {preview ? (
        <div className="card stack">
          <span className="eyebrow">Join this crew?</span>
          <h3 className="mid">{preview.name}</h3>
          <p>Started by {preview.starterName} · {preview.memberCount} {preview.memberCount === 1 ? "person" : "people"}</p>
          <p className="small muted">Tips are {MODE_NAME[preview.splitMode]}. Closes at {time(preview.closesAt)}. Your tips go to the pool from now on.</p>
          {joinForm.error && <p className="error" role="alert">{joinForm.error}</p>}
          <button className="btn primary" disabled={joinForm.busy} onClick={confirm}>{joinForm.busy ? "Joining…" : "Join crew"}</button>
          <button className="btn ghost" style={{ alignSelf: "center" }} onClick={() => setPreview(null)}>Not this one</button>
        </div>
      ) : (
        <form className="card stack" onSubmit={(e) => { e.preventDefault(); if (code.length === 4) check(); }}>
          <label className="eyebrow" htmlFor="code">Join with a code</label>
          <input id="code" className="input code-in" inputMode="numeric" autoComplete="off" maxLength={4} placeholder="····" value={code} onChange={(e) => { joinForm.setError(""); setCode(e.target.value.replace(/\D/g, "")); }} />
          {joinForm.error && <p className="error" role="alert">{joinForm.error}</p>}
          <button className="btn primary" disabled={code.length !== 4 || joinForm.busy}>{joinForm.busy ? "Checking…" : "Continue"}</button>
        </form>
      )}

      {starting ? (
        <form className="card stack" onSubmit={(e) => { e.preventDefault(); startForm.run(() => start({ name, splitMode: mode, closesInHours: hours })); }}>
          <span className="eyebrow">Start a crew</span>
          <div className="field"><label htmlFor="crew-name">Crew name</label><input id="crew-name" className="input" maxLength={60} value={name} onChange={(e) => setName(e.target.value)} placeholder="Harbor valet · Friday" /></div>
          <fieldset className="field plain">
            <legend>How to split</legend>
            <div className="seg">{MODES.map(([k, l]) => <button type="button" key={k} aria-pressed={mode === k} onClick={() => setMode(k)}>{l}</button>)}</div>
            <p className="small muted">{MODE_HELP[mode]} Only you can change this.</p>
          </fieldset>
          <div className="field"><label htmlFor="crew-hours">Closes after (hours)</label><input id="crew-hours" className="input" type="number" inputMode="numeric" min={1} max={24} value={hours} onChange={(e) => setHours(Number(e.target.value))} /></div>
          {startForm.error && <p className="error" role="alert">{startForm.error}</p>}
          <button className="btn primary" disabled={startForm.busy}>{startForm.busy ? "Starting…" : "Start crew"}</button>
        </form>
      ) : (
        <button className="btn" onClick={() => setStarting(true)}>Start a new crew</button>
      )}

      {last && (
        <div className="ticket stack">
          <div className="row between"><span className="ticket-no">Last crew · {last.name}</span><span className="demo-tag">Demo</span></div>
          <div><span className="small">Your share</span><div className="mid">{money2(last.myPayoutCents)}</div></div>
          <div className="perf" />
          <div className="list">
            {last.rows.map((r, i) => <div className="item ticket-item" key={i}><span className="avatar sm">{initials(r.name)}</span><span>{r.name}</span><span className="amt">{money2(r.payoutCents)}</span></div>)}
          </div>
        </div>
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
  const [removing, setRemoving] = useState<string | null>(null);
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
    <div className="stack" style={{ gap: 16 }}>
      <div className="pool">
        <div className="row between"><span className="eyebrow">{crew.name}</span><span className="demo-tag on-pool">Demo</span></div>
        <div className="big">{money2(crew.poolCents)}</div>
        <span className="small">in the pool · {activeCount} {activeCount === 1 ? "person" : "people"} · closes {time(crew.closesAt)}</span>
        <div className="code-row">
          <div><span className="eyebrow">Join code</span><div className="join-code">{crew.code}</div></div>
          <span className="row">
            <button className="btn small on-pool-btn" onClick={copyCode}>{copied ? "Copied" : "Copy"}</button>
            <button className="btn small on-pool-btn" aria-expanded={showQr} onClick={() => setShowQr(!showQr)}>QR</button>
          </span>
        </div>
        {showQr && origin && <div className="qr"><QRCodeSVG value={`${origin}/app?join=${crew.code}`} size={160} title={`QR code to join with code ${crew.code}`} /></div>}
      </div>

      {changedTo && <div className="banner" role="status"><span>The crew starter changed the split: tips are now {MODE_NAME[changedTo]}.</span><button className="btn small" onClick={() => setChangedTo(null)}>OK</button></div>}

      <div className="stack">
        <span className="small" style={{ fontWeight: 600 }}>How to split</span>
        <div className="seg" role="group" aria-label="How to split">
          {MODES.map(([k, l]) => (
            <button key={k} aria-pressed={mode === k} disabled={!crew.iAmStarter} onClick={() => run(() => setSplitMode({ splitMode: k }))}>{l}</button>
          ))}
        </div>
        {!crew.splitValid ? (
          crew.iAmStarter
            ? <p className="error small" role="alert">Percents add to {pctTotal}%. They need to add to 100%.</p>
            : <p className="small muted">The crew starter is setting percents. Shares appear once they add up to 100%.</p>
        ) : crew.evenFallback ? (
          <p className="small muted">{mode === "hours" ? "Hours are still at zero, so for now this splits evenly." : "All weights are zero, so this splits evenly."}</p>
        ) : (
          <p className="small muted">{MODE_HELP[mode]} {crew.iAmStarter ? "Only you can change this." : "Only the person who started the crew can change this."}</p>
        )}
      </div>

      <div className="list">
        {crew.members.map((m) => (
          <div className="item member" key={m.memberId}>
            <div className="avatar sm">{initials(m.name)}</div>
            <div className="stack" style={{ gap: 0, minWidth: 0 }}>
              <span>{m.name}{m.isMe ? " (you)" : ""}</span>
              <span className="small muted">{[m.jobTitle, m.isStarter ? "started crew" : "", m.left ? "left, share pending" : ""].filter(Boolean).join(" · ")}</span>
              {crew.iAmStarter && !m.isMe && (removing === m.memberId ? (
                <span className="row" role="alert">
                  <span className="small">Remove {m.name.split(" ")[0]}? Their tips go back to them.</span>
                  <button className="link" disabled={busy} onClick={() => run(() => removeMember({ memberId: m.memberId })).then(() => setRemoving(null))}>Remove</button>
                  <button className="link muted" onClick={() => setRemoving(null)}>Keep</button>
                </span>
              ) : (
                <button className="link muted" onClick={() => setRemoving(m.memberId)} aria-label={`Remove ${m.name} from crew`}>Remove</button>
              ))}
            </div>
            <span className="row" style={{ marginLeft: "auto", flex: "none" }}>
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
              <span className="amt" style={{ minWidth: 72, textAlign: "right" }}>{m.projectedCents === null ? "—" : money2(m.projectedCents)}</span>
            </span>
          </div>
        ))}
      </div>
      {error && <p className="error" role="alert">{error}</p>}

      {crew.iAmStarter ? (
        confirming === "close" ? (
          <div className="stack confirm">
            <span>Close the crew and pay everyone their share now? This can&apos;t be undone.</span>
            <button className="btn primary" disabled={busy} onClick={() => run(() => close({}))}>{busy ? "Closing…" : "Close and split"}</button>
            <button className="btn ghost" style={{ alignSelf: "center" }} onClick={() => setConfirming(null)}>Keep crew open</button>
          </div>
        ) : (
          <button className="btn primary" onClick={() => setConfirming("close")}>Close crew and split now</button>
        )
      ) : confirming === "leave" ? (
        <div className="stack confirm">
          <span>Leave this crew? You still get your share when it closes, and new tips stay yours.</span>
          <button className="btn" disabled={busy} onClick={() => run(() => leave({}))}>Leave crew</button>
          <button className="btn ghost" style={{ alignSelf: "center" }} onClick={() => setConfirming(null)}>Stay</button>
        </div>
      ) : (
        <button className="btn ghost" style={{ alignSelf: "center" }} onClick={() => setConfirming("leave")}>Leave crew</button>
      )}
    </div>
  );
}
