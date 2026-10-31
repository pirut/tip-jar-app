import Link from "next/link";
import { DemoBar } from "@/components/DemoBar";
import { LegalLinks } from "@/components/LegalLinks";

export default function Home() {
  return (
    <>
      <DemoBar />
      <main className="page landing">
        <span className="wordmark">Tip Jar</span>
        <div className="hero">
          <div className="stack" style={{ gap: 16 }}>
            <h1>Tip the valet in five seconds</h1>
            <p className="muted lead">
              Tip Jar lets valets, cart attendants and everyone else who hustles for tips get paid by tap or QR code, and
              pool tips with today&apos;s crew. Guests don&apos;t need an app or an account.
            </p>
            <Link className="btn primary" href="/app">Make your tip link</Link>
            <p className="small muted">Tipping someone? Scan the QR code on their badge.</p>
          </div>
          <div className="ticket hero-ticket" aria-hidden>
            <div className="row between">
              <span className="ticket-no">TIP CLAIM № 004417</span>
              <span className="demo-tag">Demo</span>
            </div>
            <div className="big" style={{ marginTop: 10 }}>$10</div>
            <p className="small">to Marcus at The Harbor Hotel</p>
            <div className="perf" />
            <div className="row between small"><span>Fees covered by the guest</span><span className="amt">$0.84</span></div>
          </div>
        </div>
        <LegalLinks />
      </main>
    </>
  );
}
