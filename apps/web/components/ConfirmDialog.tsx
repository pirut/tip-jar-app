"use client";

import { useEffect, useId, useRef } from "react";

type Props = {
  open: boolean;
  title: string;
  children: React.ReactNode;
  confirmLabel: string;
  busyLabel?: string;
  cancelLabel: string;
  busy?: boolean;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
};

// A native dialog traps focus, closes on Escape and returns focus to the button that opened it.
export function ConfirmDialog({ open, title, children, confirmLabel, busyLabel, cancelLabel, busy, danger, onConfirm, onCancel }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  return (
    <dialog ref={ref} className="dialog" aria-labelledby={titleId} onCancel={(e) => { e.preventDefault(); if (!busy) onCancel(); }}>
      <h2 id={titleId} className="t-page">{title}</h2>
      <div className="muted" style={{ marginTop: 8 }}>{children}</div>
      <div className="dialog-actions">
        <button type="button" className="btn" disabled={busy} onClick={onCancel}>{cancelLabel}</button>
        <button type="button" className={danger ? "btn danger" : "btn primary"} disabled={busy} onClick={onConfirm}>
          {busy ? <><span className="spinner" aria-hidden />{busyLabel ?? confirmLabel}</> : confirmLabel}
        </button>
      </div>
    </dialog>
  );
}
