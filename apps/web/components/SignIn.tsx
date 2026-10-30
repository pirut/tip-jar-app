"use client";

import { SignIn as ClerkSignIn } from "@clerk/nextjs";

export function SignIn() {
  return (
    <div className="stack" style={{ gap: 14 }}>
      <h1>Start getting tipped</h1>
      <ClerkSignIn routing="hash" withSignUp />
    </div>
  );
}
