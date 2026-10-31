import Link from "next/link";

export default function NotFound() {
  return (
    <main className="page">
      <Link className="wordmark" href="/">Tip Jar</Link>
      <div className="stack grow" style={{ justifyContent: "center", gap: 18 }}>
        <div className="ticket">
          <span className="ticket-no">TIP CLAIM № ——————</span>
          <h2 style={{ marginTop: 10 }}>We couldn&apos;t find that person</h2>
          <p className="small" style={{ marginTop: 6 }}>Check the QR code or link and try again.</p>
        </div>
        <Link className="btn" href="/">Go to Tip Jar</Link>
      </div>
    </main>
  );
}
