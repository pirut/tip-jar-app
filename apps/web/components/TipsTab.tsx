"use client";

import { useEffect, useState } from "react";
import { useQuery } from "convex/react";
import { QRCodeSVG } from "qrcode.react";
import { api } from "@convex/_generated/api";
import { money2, time } from "@/lib/format";

export function TipsTab({ handle }: { handle: string }) {
  const today = useQuery(api.tips.today);
  const [origin, setOrigin] = useState("https://tip.jrbussard.com");
  const [copied, setCopied] = useState(false);
  useEffect(() => setOrigin(window.location.origin), []);
  const link = `${origin}/${handle}`;

  async function copy() {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked; the link is still visible to select */
    }
  }

  return (
    <div className="stack" style={{ gap: 18 }}>
      <div className="stack" style={{ gap: 4 }}>
        <span className="eyebrow">Tips today</span>
        <div className="big">{today ? money2(today.totalCents) : "—"}</div>
        {today && <span className="small muted">{today.count} tip{today.count === 1 ? "" : "s"}</span>}
      </div>
      <div className="card stack" style={{ alignItems: "center", textAlign: "center" }}>
        <span className="eyebrow">Your tip QR code</span>
        <div className="qr"><QRCodeSVG value={link} size={180} /></div>
        <p className="small">Print it for your badge or stand. Guests scan it and pay with Apple Pay or Google Pay.</p>
        <div className="row" style={{ flexWrap: "wrap", justifyContent: "center" }}>
          <code className="small">{link.replace(/^https?:\/\//, "")}</code>
          <button className="btn small" onClick={copy}>{copied ? "Copied" : "Copy link"}</button>
        </div>
      </div>
      <div className="stack" style={{ gap: 2 }}>
        <span className="eyebrow">Recent</span>
        {today && today.recent.length === 0 && <p className="muted small">No tips yet. Open your link to try a demo tip.</p>}
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
