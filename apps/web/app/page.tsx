import Link from "next/link";

export default function Home() {
  return (
    <main className="page">
      <span className="wordmark">Tip Jar</span>
      <div className="stack" style={{ gap: 14, marginTop: 24 }}>
        <h1>Tip the valet in five seconds</h1>
        <p className="muted">
          Tip Jar lets valets, cart attendants and everyone else who hustles for tips get paid by tap or QR code, pool
          tips with today&apos;s crew, and cash out the same day.
        </p>
      </div>
      <div className="card stack">
        <span className="eyebrow">Work for tips?</span>
        <p>Make your tip link and QR code in a minute.</p>
        <Link className="btn primary" href="/app">Get started</Link>
      </div>
      <p className="small muted">Tipping someone? Scan the QR code on their badge.</p>
    </main>
  );
}
