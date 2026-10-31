"use client";

import { Logo } from "@/components/Brand";

export default function ErrorPage({ reset }: { reset: () => void }) {
  return (
    <div className="center-page">
      <div className="site-head"><Logo /></div>
      <main className="center-body">
        <h1 className="t-title">That didn&apos;t load</h1>
        <p className="muted">Check your signal and try again.</p>
        <button className="btn primary" onClick={reset}>Try again</button>
      </main>
    </div>
  );
}
