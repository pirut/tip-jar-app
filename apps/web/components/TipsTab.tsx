"use client";

import { useEffect, useState } from "react";
import { useQuery } from "convex/react";
import { QRCodeSVG } from "qrcode.react";
import { api } from "@convex/_generated/api";
import { money2, time } from "@/lib/format";
import { useDayStart } from "@/lib/useDayStart";

export function TipsTab({ handle, name }: { handle: string; name: string }) {
  const dayStart = useDayStart();
  const today = useQuery(api.tips.today, { dayStart });
  const [origin, setOrigin] = useState("https://tip.jrbussard.com");
  const [note, setNote] = useState("");
  const [canShare, setCanShare] = useState(false);
  useEffect(() => {
    setOrigin(window.location.origin);
    setCanShare(typeof navigator.share === "function");
  }, []);
  const link = `${origin}/${handle}`;
  const display = link.replace(/^https?:\/\//, "");

  async function copy() {
    try {
      await navigator.clipboard.writeText(link);
      setNote("Link copied");
    } catch {
      setNote("Couldn't copy. Press and hold the link above instead.");
    }
    setTimeout(() => setNote(""), 3000);
  }

  async function share() {
    try {
      await navigator.share({ title: `Tip ${name}`, url: link });
    } catch {
      /* the person closed the share sheet */
    }
  }

  return (
    <div className="stack" style={{ gap: 18 }}>
      <div className="stack" style={{ gap: 4 }}>
        <span className="eyebrow">Tips today <span className="demo-tag">Demo</span></span>
        <div className="big">{today ? money2(today.totalCents) : "—"}</div>
        {today && (
          <span className="small muted">
            {today.count} tip{today.count === 1 ? "" : "s"}
            {today.crewCents > 0 ? ` · ${money2(today.crewCents)} went to your crew pool` : ""}
          </span>
        )}
      </div>
      <div className="card stack print-badge" style={{ alignItems: "center", textAlign: "center" }}>
        <span className="eyebrow">Your tip QR code</span>
        <h2 className="print-only">Tip {name}</h2>
        <div className="qr"><QRCodeSVG value={link} size={180} title={`QR code for ${display}`} /></div>
        <p className="small no-print">Print it for your badge or stand. Guests scan it and tip in seconds, with no app.</p>
        <a className="small mono" href={link} target="_blank" rel="noreferrer">{display}</a>
        <div className="row no-print" style={{ flexWrap: "wrap", justifyContent: "center" }}>
          {canShare && <button className="btn small primary" onClick={share}>Share</button>}
          <button className="btn small" onClick={copy}>Copy link</button>
          <button className="btn small" onClick={() => window.print()}>Print</button>
        </div>
        {note && <p className="small muted" role="status">{note}</p>}
      </div>
      <div className="stack no-print" style={{ gap: 2 }}>
        <span className="eyebrow">Recent</span>
        {today && today.recent.length === 0 && (
          <p className="muted small">No tips yet. <a href={link} target="_blank" rel="noreferrer">Open your link</a> to try a demo tip.</p>
        )}
        <div className="list">
          {today?.recent.map((t) => (
            <div className="item" key={t._id}>
              <div className="stack" style={{ gap: 0 }}>
                <span>{t.payerLabel} {t.demo && <span className="demo-tag">Demo</span>}</span>
                <span className="small muted">{time(t.at)} · {t.source === "qr" ? "QR code" : "Tap to Pay"}{t.toCrew ? " · to crew pool" : ""}</span>
              </div>
              <span className="amt">+{money2(t.netCents)}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
