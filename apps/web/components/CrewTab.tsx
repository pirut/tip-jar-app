"use client";

import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import type { SplitMode } from "@convex/lib/split";
import { errorText, initials, money2, time } from "@/lib/format";

const MODES: [SplitMode, string][] = [["even", "Even"], ["hours", "Hours"], ["shares", "Shares"], ["custom", "Custom %"]];
const MODE_HELP: Record<SplitMode, string> = {
  even: "Same amount for everyone.",
  hours: "Based on time each person has been in the crew.",
  shares: "Weighted by role, like lead 1.5, valet 1, runner 0.5.",
  custom: "A fixed percent per person. Must add up to 100.",
};

export function CrewTab() {
  const data = useQuery(api.crews.current);
  const last = useQuery(api.crews.lastClosed);
  const [error, setError] = useState("");
  const run = async (fn: () => Promise<unknown>) => {
    setError("");
    try { await fn(); } catch (e) { setError(errorText(e)); }
  };

  if (data === undefined) return <p className="muted">Loading…</p>;
  if (!data?.crew) return <NoCrew last={last ?? null} error={error} run={run} />;
  return <InCrew crew={data.crew} error={error} run={run} />;
}

type Run = (fn: () => Promise<unknown>) => Promise<void>;

function NoCrew({ last, error, run }: { last: { name: string; myPayoutCents: number; rows: { name: string; payoutCents: number }[] } | null; error: string; run: Run }) {
  const start = useMutation(api.crews.start);
  const join = useMutation(api.crews.join);
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [mode, setMode] = useState<SplitMode>("even");
  const [hours, setHours] = useState(8);
  const [starting, setStarting] = useState(false);

  return (
    <div className="stack" style={{ gap: 16 }}>
      <span className="eyebrow">Today&apos;s crew</span>
      <h2>Pool tips with who you&apos;re working with</h2>
      <p className="muted">Tips you get while in a crew go into one pool, split when the crew closes. Tips from before you join stay yours.</p>

      <form className="card stack" onSubmit={(e) => { e.preventDefault(); run(() => join({ code })); }}>
        <label className="eyebrow" htmlFor="code">Join with a code</label>
        <input id="code" className="input code-in" inputMode="numeric" maxLength={4} placeholder="····" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} />
        <button className="btn primary" disabled={code.length !== 4}>Join crew</button>
      </form>

      {starting ? (
        <form className="card stack" onSubmit={(e) => { e.preventDefault(); run(() => start({ name, splitMode: mode, closesInHours: hours })); }}>
          <span className="eyebrow">Start a crew</span>
          <div className="field"><label htmlFor="crew-name">Crew name</label><input id="crew-name" className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Harbor valet · Friday" /></div>
          <div className="field"><label>How to split</label>
            <div className="seg">{MODES.map(([k, l]) => <button type="button" key={k} aria-pressed={mode === k} onClick={() => setMode(k)}>{l}</button>)}</div>
            <p className="small muted">{MODE_HELP[mode]} Only you can change this.</p>
          </div>
          <div className="field"><label htmlFor="crew-hours">Closes after (hours)</label><input id="crew-hours" className="input" type="number" min={1} max={24} value={hours} onChange={(e) => setHours(Number(e.target.value))} /></div>
          <button className="btn primary">Start crew</button>
        </form>
      ) : (
        <button className="btn" onClick={() => setStarting(true)}>Start a new crew</button>
      )}
      {error && <p className="error">{error}</p>}

      {last && (
        <div className="card stack">
          <span className="eyebrow">Last crew · {last.name}</span>
          <p>Your share: <b>{money2(last.myPayoutCents)}</b></p>
          <div className="list">{last.rows.map((r, i) => <div className="item" key={i}><span>{r.name}</span><span className="amt">{money2(r.payoutCents)}</span></div>)}</div>
        </div>
      )}
    </div>
  );
}

type CrewData = NonNullable<NonNullable<ReturnType<typeof useQuery<typeof api.crews.current>>>["crew"]>;

function InCrew({ crew, error, run }: { crew: CrewData; error: string; run: Run }) {
  const setSplitMode = useMutation(api.crews.setSplitMode);
  const setWeights = useMutation(api.crews.setMemberWeights);
  const close = useMutation(api.crews.close);
  const leave = useMutation(api.crews.leave);
  const [confirming, setConfirming] = useState(false);
  const mode = crew.splitMode as SplitMode;
  const pctTotal = crew.members.reduce((a, m) => a + m.pct, 0);

  const field = mode === "hours" ? "hours" : mode === "shares" ? "shares" : mode === "custom" ? "pct" : null;

  return (
    <div className="stack" style={{ gap: 16 }}>
      <div className="pool">
        <div className="row between"><span className="eyebrow">{crew.name}</span><span className="eyebrow">Code {crew.code}</span></div>
        <div className="big">{money2(crew.poolCents)}</div>
        <span className="small">in the pool · {crew.members.length} {crew.members.length === 1 ? "person" : "people"} · closes {time(crew.closesAt)}</span>
      </div>

      <div className="stack">
        <span className="small" style={{ fontWeight: 600 }}>How to split</span>
        <div className="seg">
          {MODES.map(([k, l]) => (
            <button key={k} aria-pressed={mode === k} disabled={!crew.iAmStarter} onClick={() => run(() => setSplitMode({ splitMode: k }))}>{l}</button>
          ))}
        </div>
        {crew.splitValid ? (
          <p className="small muted">{MODE_HELP[mode]} {crew.iAmStarter ? "Only you can change this." : "Only the person who started the crew can change this."}</p>
        ) : (
          <p className="error small">Percents add to {pctTotal}%. They need to add to 100%.</p>
        )}
      </div>

      <div className="list">
        {crew.members.map((m) => (
          <div className="item" key={m.memberId}>
            <div className="avatar sm">{initials(m.name)}</div>
            <div className="stack" style={{ gap: 0, minWidth: 0 }}>
              <span>{m.name}{m.isMe ? " (you)" : ""}</span>
              <span className="small muted">{[m.jobTitle, m.isStarter ? "started crew" : ""].filter(Boolean).join(" · ")}</span>
            </div>
            <span className="row" style={{ marginLeft: "auto" }}>
              {field && (crew.iAmStarter ? (
                <input
                  className="num-in"
                  type="number"
                  step={field === "pct" ? 1 : 0.25}
                  min={0}
                  aria-label={`${field} for ${m.name}`}
                  defaultValue={m[field]}
                  key={`${field}-${m[field]}`}
                  onBlur={(e) => run(() => setWeights({ memberId: m.memberId, [field]: Number(e.target.value) }))}
                />
              ) : (
                <span className="small muted">{m[field]}{field === "pct" ? "%" : field === "hours" ? "h" : "×"}</span>
              ))}
              <span className="amt" style={{ minWidth: 76, textAlign: "right" }}>{m.projectedCents === null ? "—" : money2(m.projectedCents)}</span>
            </span>
          </div>
        ))}
      </div>
      {error && <p className="error">{error}</p>}

      {crew.iAmStarter ? (
        confirming ? (
          <div className="banner">
            <span>Close the crew and pay everyone their share now?</span>
            <span className="row">
              <button className="btn small" onClick={() => setConfirming(false)}>Cancel</button>
              <button className="btn small primary" onClick={() => run(() => close({}))}>Close and split</button>
            </span>
          </div>
        ) : (
          <button className="btn primary" disabled={!crew.splitValid} onClick={() => setConfirming(true)}>Close crew and split now</button>
        )
      ) : (
        <button className="btn ghost" style={{ alignSelf: "center" }} onClick={() => run(() => leave({}))}>Leave crew</button>
      )}
    </div>
  );
}
