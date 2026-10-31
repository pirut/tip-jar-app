"use client";

import { useEffect, useState } from "react";
import { useMutation } from "convex/react";
import { api } from "@convex/_generated/api";
import { handleError } from "@convex/lib/handles";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { errorText } from "@/lib/format";

type Profile = { name: string; handle: string; jobTitle: string; workplace: string };
type Props = {
  initial?: Profile;
  email?: string;
  onDone?: () => void;
  onCancel?: () => void;
  onSignOut: () => void;
  onDelete?: () => Promise<void>;
};

export function ProfileForm({ initial, email, onDone, onCancel, onSignOut, onDelete }: Props) {
  const save = useMutation(api.workers.saveProfile);
  const [linkHost, setLinkHost] = useState("tip.jrbussard.com");
  useEffect(() => { setLinkHost(window.location.host); }, []);
  const [p, setP] = useState<Profile>(initial ?? { name: "", handle: "", jobTitle: "Valet", workplace: "" });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [handleTouched, setHandleTouched] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  const set = (k: keyof Profile) => (e: React.ChangeEvent<HTMLInputElement>) => setP({ ...p, [k]: e.target.value });
  const handleChanged = !!initial && initial.handle !== p.handle;
  const handleProblem = handleTouched && p.handle ? handleError(p.handle) : null;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
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

  async function confirmDeleting() {
    setDeleteError("");
    setDeleting(true);
    try {
      await onDelete?.();
    } catch (err) {
      setDeleteError(errorText(err));
      setConfirmDelete(false);
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="stack-lg" style={{ gap: 24, maxWidth: 480 }}>
      <form className="stack-lg" onSubmit={submit}>
        <div className="stack" style={{ gap: 4 }}>
          <h1 className={initial ? "t-page" : "t-title"}>{initial ? "Edit profile" : "Set up your tip page"}</h1>
          {!initial && <p className="muted">Guests see your name, job and workplace when they tip.</p>}
        </div>
        <div className="field"><label htmlFor="name">Your name</label><input className="input" id="name" autoComplete="name" maxLength={60} value={p.name} onChange={set("name")} required /></div>
        <div className="field">
          <label htmlFor="handle">Your link</label>
          <div className={handleProblem ? "prefixed invalid" : "prefixed"}>
            <span title={linkHost} style={{ maxWidth: "60%", overflow: "hidden", textOverflow: "ellipsis" }}>{linkHost}/</span>
            <input id="handle" autoCapitalize="none" autoCorrect="off" spellCheck={false} maxLength={30} aria-invalid={!!handleProblem} aria-describedby="handle-note" value={p.handle} onBlur={() => setHandleTouched(true)} onChange={(e) => setP({ ...p, handle: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "") })} placeholder="marcus" required />
          </div>
          <div id="handle-note">
            {handleProblem && <p className="error small">{handleProblem}</p>}
            {!handleProblem && handleChanged && <p className="warn-text">Changing your link breaks any QR codes you&apos;ve already printed.</p>}
          </div>
        </div>
        <div className="field"><label htmlFor="job">Job</label><input className="input" id="job" maxLength={60} value={p.jobTitle} onChange={set("jobTitle")} placeholder="Valet, cart attendant…" /></div>
        <div className="field"><label htmlFor="place">Where you work</label><input className="input" id="place" maxLength={80} value={p.workplace} onChange={set("workplace")} placeholder="The Harbor Hotel" /></div>
        {error && <p className="error" role="alert">{error}</p>}
        <div className="row wrap">
          <button className={initial ? "btn primary" : "btn primary full"} disabled={busy}>{busy ? <><span className="spinner" aria-hidden />Saving…</> : initial ? "Save changes" : "Create my tip page"}</button>
          {onCancel && <button type="button" className="btn ghost" onClick={onCancel}>Cancel</button>}
        </div>
        {!initial && <button type="button" className="btn ghost" style={{ alignSelf: "center" }} onClick={onSignOut}>Sign out</button>}
      </form>

      {initial && (
        <>
          <section className="section-line stack-lg">
            <h2 className="t-sub">Account</h2>
            <div className="row between wrap">
              <span className="muted" style={{ overflowWrap: "anywhere" }}>{email ? `Signed in as ${email}` : "Signed in"}</span>
              <button type="button" className="btn" onClick={onSignOut}>Sign out</button>
            </div>
          </section>
          {onDelete && (
            <section className="section-line stack-lg">
              <h2 className="t-sub">Delete account</h2>
              <div className="row between wrap">
                <span className="muted grow" style={{ minWidth: 200 }}>Removes your profile, tips and cash-out history. You can delete once any crew you belong to has closed.</span>
                <button type="button" className="btn" onClick={() => setConfirmDelete(true)}>Delete account</button>
              </div>
              {deleteError && <p className="error" role="alert">{deleteError}</p>}
            </section>
          )}
        </>
      )}

      <ConfirmDialog open={confirmDelete} title="Delete your account?" confirmLabel="Delete account" busyLabel="Deleting…" cancelLabel="Keep account" danger busy={deleting} onConfirm={confirmDeleting} onCancel={() => setConfirmDelete(false)}>
        This removes your profile, tips and cash-out history. Past crew records keep a row with no name, so other people&apos;s payouts still add up. This can&apos;t be undone.
      </ConfirmDialog>
    </div>
  );
}
