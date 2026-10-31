"use client";

export default function ErrorPage({ reset }: { reset: () => void }) {
  return (
    <main className="page">
      <span className="wordmark">Tip Jar</span>
      <div className="stack grow" style={{ justifyContent: "center", gap: 14 }}>
        <h2>That didn&apos;t load</h2>
        <p className="muted">Check your signal and try again.</p>
        <button className="btn primary" onClick={reset}>Try again</button>
      </div>
    </main>
  );
}
