"use client";

import { useState } from "react";
import { useMutation } from "convex/react";
import { api } from "@convex/_generated/api";
import { errorText } from "@/lib/format";

type Profile = { name: string; handle: string; jobTitle: string; workplace: string };

export function ProfileForm({ initial, onDone }: { initial?: Profile; onDone?: () => void }) {
  const save = useMutation(api.workers.saveProfile);
  const [p, setP] = useState<Profile>(initial ?? { name: "", handle: "", jobTitle: "Valet", workplace: "" });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const set = (k: keyof Profile) => (e: React.ChangeEvent<HTMLInputElement>) => setP({ ...p, [k]: e.target.value });

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      await save(p);
      onDone?.();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="stack" style={{ gap: 14 }} onSubmit={submit}>
      <h1>{initial ? "Edit your profile" : "Set up your tip page"}</h1>
      <div className="field"><label htmlFor="name">Your name</label><input className="input" id="name" value={p.name} onChange={set("name")} required /></div>
      <div className="field">
        <label htmlFor="handle">Your link</label>
        <div className="row"><span className="muted small">tip.jrbussard.com/</span>
          <input className="input" id="handle" value={p.handle} onChange={(e) => setP({ ...p, handle: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "") })} placeholder="marcus" required />
        </div>
      </div>
      <div className="field"><label htmlFor="job">Job</label><input className="input" id="job" value={p.jobTitle} onChange={set("jobTitle")} placeholder="Valet, cart attendant…" /></div>
      <div className="field"><label htmlFor="place">Where you work</label><input className="input" id="place" value={p.workplace} onChange={set("workplace")} placeholder="The Harbor Hotel" /></div>
      {error && <p className="error">{error}</p>}
      <button className="btn primary" disabled={busy}>Save</button>
    </form>
  );
}
