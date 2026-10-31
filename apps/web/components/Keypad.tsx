"use client";

import { IconBackspace } from "@/components/Icons";

const KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", ".", "0", "del"];

export function Keypad({ onKey, disabled = false }: { onKey: (k: string) => void; disabled?: boolean }) {
  return (
    <div className="keypad">
      {KEYS.map((k) => (
        <button key={k} type="button" disabled={disabled} onClick={() => onKey(k)} aria-label={k === "del" ? "Delete" : k === "." ? "Decimal point" : k}>
          {k === "del" ? <IconBackspace size={22} /> : k}
        </button>
      ))}
    </div>
  );
}
