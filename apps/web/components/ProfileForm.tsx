"use client";

import { useState } from "react";
import { useMutation } from "convex/react";
import { useUser } from "@clerk/nextjs";
import { api } from "@convex/_generated/api";
import { errorText } from "@/lib/format";

type Profile = { name: string; handle: string; jobTitle: string; workplace: string };

export function ProfileForm({ initial, onDone, onCancel, onSignOut }: { initial?: Profile; onDone?: () => void; onCancel?: () => void; onSignOut: () => void }) {
  const save = useMutation(api.workers.saveProfile);
  const remove = useMutation(api.workers.deleteAccount);
  const { user } = useUser();
  const [p, setP] = useState<Profile>(initial ?? { name: "", handle: "", jobTitle: "Valet", workplace: "" });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const set = (k: keyof Profile) => (e: React.ChangeEvent<HTMLInputElement>) => setP({ ...p, [k]: e.target.value });
  const handleChanged = !!initial && initial.handle !== p.handle;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      await save({ name: p.name, handle: p.handle, jobTitle: p.jobTitle, workplace: p.workplace });
      onDone?.();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  async function deleteAccount() {
    setError("");
    setBusy(true);
    try {
      await remove({});
      await user?.delete();
      onSignOut();
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  }

  return (
    <form className="stack" style={{ gap: 14 }} onSubmit={submit}>
      <h1 style={{ marginBottom: 8 }}>{initial ? "Edit your profile" : "Set up your tip page"}</h1>
      <div className="field"><label htmlFor="name">Your name</label><input className="input" id="name" autoComplete="name" maxLength={60} value={p.name} onChange={set("name")} required /></div>
      <div className="field">
        <label htmlFor="handle">Your link</label>
        <div className="prefixed">
          <span>tip.jrbussard.com/</span>
          <input id="handle" autoCapitalize="none" autoCorrect="off" spellCheck={false} maxLength={30} value={p.handle} onChange={(e) => setP({ ...p, handle: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "") })} placeholder="marcus" required />
        </div>
        {handleChanged && <p className="small warn-text">Changing your link breaks any QR codes you&apos;ve already printed.</p>}
      </div>
      <div className="field"><label htmlFor="job">Job</label><input className="input" id="job" maxLength={60} value={p.jobTitle} onChange={set("jobTitle")} placeholder="Valet, cart attendant…" /></div>
      <div className="field"><label htmlFor="place">Where you work</label><input className="input" id="place" maxLength={80} value={p.workplace} onChange={set("workplace")} placeholder="The Harbor Hotel" /></div>
      {error && <p className="error" role="alert">{error}</p>}
      <button className="btn primary" disabled={busy}>{busy ? "Saving…" : "Save"}</button>
      {onCancel && <button type="button" className="btn ghost" style={{ alignSelf: "center" }} onClick={onCancel}>Cancel</button>}
      <button type="button" className="btn ghost" style={{ alignSelf: "center" }} onClick={onSignOut}>Sign out</button>
      {initial && (confirmDelete ? (
        <div className="banner" role="alert">
          <span>Delete your account, tips and cash-out history? This can&apos;t be undone.</span>
          <span className="row">
            <button type="button" className="btn small" onClick={() => setConfirmDelete(false)}>Keep it</button>
            <button type="button" className="btn small danger" disabled={busy} onClick={deleteAccount}>Delete</button>
          </span>
        </div>
      ) : (
        <button type="button" className="btn ghost" style={{ alignSelf: "center" }} onClick={() => setConfirmDelete(true)}>Delete account</button>
      ))}
    </form>
  );
}
