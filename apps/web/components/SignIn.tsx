"use client";

import { useState } from "react";
import { SignIn as ClerkSignIn } from "@clerk/nextjs";
import { Logo } from "@/components/Brand";
import { IconCheck } from "@/components/Icons";
import { returnPath } from "@/lib/format";

const POINTS = ["Your own tip page and QR code", "Today's tips and your earnings", "Tip pooling with your crew"];

export function SignIn() {
  // A scanned crew QR opens /app?join=1234 signed out, so the code has to survive signing in.
  const [back] = useState(() => (typeof window === "undefined" ? "/app" : returnPath(window.location.search)));
  const joinCode = new URLSearchParams(back.split("?")[1]).get("join");
  return (
    <main className="signin">
      <div className="signin-aside">
        <Logo />
        <h1 className="t-section" style={{ marginTop: 16 }}>Get your tip link</h1>
        <ul className="feature-list">
          {POINTS.map((p) => <li key={p}><IconCheck size={18} /><span>{p}</span></li>)}
        </ul>
      </div>
      <div className="signin-main">
        <Logo />
        <div className="signin-inner">
          {joinCode && <p className="notice">Sign in to join crew {joinCode}.</p>}
          <ClerkSignIn routing="hash" withSignUp fallbackRedirectUrl={back} signUpFallbackRedirectUrl={back} />
        </div>
      </div>
    </main>
  );
}
