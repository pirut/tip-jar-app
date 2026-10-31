"use client";

import { useEffect, useRef, useState } from "react";
import { useQuery } from "convex/react";
import { QRCodeSVG } from "qrcode.react";
import { api } from "@convex/_generated/api";
import { IconCheck, IconCopy, IconPrint, IconShare } from "@/components/Icons";
import { PayoutSetupCard } from "@/components/RealEarnings";
import { money2, time } from "@/lib/format";
import { useDayStart } from "@/lib/useDayStart";

export function TipsTab({ handle, name }: { handle: string; name: string }) {
  const dayStart = useDayStart();
  const today = useQuery(api.tips.today, { dayStart });
  const status = useQuery(api.payments.status);
  const real = !!status && status.stage !== "demo";
  const [origin, setOrigin] = useState("https://tip.jrbussard.com");
  const [copied, setCopied] = useState<"yes" | "no" | null>(null);
  const [canShare, setCanShare] = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => {
    setOrigin(window.location.origin);
    setCanShare(typeof navigator.share === "function");
    return () => clearTimeout(copyTimer.current);
  }, []);
  const link = `${origin}/${handle}`;
  const display = link.replace(/^https?:\/\//, "");

  async function copy() {
    try {
      await navigator.clipboard.writeText(link);
      setCopied("yes");
    } catch {
      setCopied("no");
    }
    clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(() => setCopied(null), 2500);
  }

  async function share() {
    try {
      await navigator.share({ title: `Tip ${name}`, url: link });
    } catch {
      /* the person closed the share sheet */
    }
  }

  return (
    <div className="dash">
      <div className="dash-main">
        <div className="stack" style={{ gap: 4 }}>
          <h1 className="stat-head">Tips today {!real ? <span className="demo-tag">Demo</span> : status.testMode ? <span className="demo-tag">Test</span> : null}</h1>
          {today ? <div className="amount">{money2(today.totalCents)}</div> : <div className="skel" style={{ width: 160, height: 40 }} />}
          {today && (
            <p className="small muted">
              {today.count} tip{today.count === 1 ? "" : "s"}
              {today.crewCents > 0 ? `, ${money2(today.crewCents)} to your crew pool` : ""}
            </p>
          )}
        </div>
        {real && <PayoutSetupCard stage={status.stage} />}
        <section className="dash-recent">
          <h2 className="sec-title">Recent</h2>
          {today === undefined && <div className="skel" style={{ height: 120 }} />}
          {today && today.recent.length === 0 && (
            <p className="muted">No tips yet. {real ? "Show guests your QR code to get started." : <><a className="link-text" href={link} target="_blank" rel="noreferrer">Open your link</a> to try a demo tip.</>}</p>
          )}
          <div className="list">
            {today?.recent.map((t) => (
              <div className="item" key={t._id}>
                <div className="stack grow" style={{ gap: 0 }}>
                  <span className="row" style={{ gap: 6 }}>{t.payerLabel}{t.demo && <span className="demo-tag quiet">Demo</span>}{t.test && <span className="demo-tag quiet">Test</span>}{t.refunded && <span className="demo-tag quiet">Refunded</span>}{t.disputed && <span className="demo-tag quiet">Disputed</span>}</span>
                  <span className="small muted">{time(t.at)}, {t.source === "qr" ? "QR code" : "Tap to Pay"}{t.toCrew ? ", to crew pool" : ""}</span>
                </div>
                <span className="item-amt">+{money2(t.netCents)}</span>
              </div>
            ))}
          </div>
        </section>
      </div>
      <aside className="dash-side">
        <section className="qr-block print-badge">
          <h2 className="t-sub no-print">Your tip QR code</h2>
          <h2 className="t-page print-only">Tip {name}</h2>
          <div className="qr"><QRCodeSVG value={link} size={168} title={`QR code for ${display}`} /></div>
          <a className="qr-link" href={link} target="_blank" rel="noreferrer">{display}</a>
          <p className="small muted no-print">Print it for your badge or stand. Guests scan it to tip, with no app.{real ? " Tap to Pay is coming later." : ""}</p>
          <div className="qr-actions no-print">
            {canShare && <button className="btn" onClick={share}><IconShare size={18} />Share</button>}
            <button className="btn" onClick={copy}>{copied === "yes" ? <IconCheck size={18} /> : <IconCopy size={18} />}{copied === "yes" ? "Copied" : "Copy link"}</button>
            <button className="btn" onClick={() => window.print()}><IconPrint size={18} />Print</button>
          </div>
          <div className="no-print" role="status">{copied === "no" && <p className="small error">Couldn&apos;t copy. Press and hold the link instead.</p>}</div>
        </section>
      </aside>
    </div>
  );
}
