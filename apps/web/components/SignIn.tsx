"use client";

import { useState } from "react";
import { useAuthActions } from "@convex-dev/auth/react";

export function SignIn() {
  const { signIn } = useAuthActions();
  const [flow, setFlow] = useState<"signIn" | "signUp">("signUp");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError("");
    setBusy(true);
    const form = new FormData(e.currentTarget);
    form.set("flow", flow);
    try {
      await signIn("password", form);
    } catch {
      setError(flow === "signIn" ? "That email and password don't match." : "Couldn't create the account. Use a password of 8+ characters, or sign in if you already have one.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="stack" style={{ gap: 14 }} onSubmit={submit}>
      <h1>{flow === "signUp" ? "Start getting tipped" : "Welcome back"}</h1>
      <div className="field">
        <label htmlFor="email">Email</label>
        <input className="input" id="email" name="email" type="email" autoComplete="email" required />
      </div>
      <div className="field">
        <label htmlFor="password">Password</label>
        <input className="input" id="password" name="password" type="password" minLength={8} autoComplete={flow === "signUp" ? "new-password" : "current-password"} required />
      </div>
      {error && <p className="error">{error}</p>}
      <button className="btn primary" disabled={busy}>{flow === "signUp" ? "Create account" : "Sign in"}</button>
      <button type="button" className="btn ghost" style={{ alignSelf: "center" }} onClick={() => setFlow(flow === "signUp" ? "signIn" : "signUp")}>
        {flow === "signUp" ? "I already have an account" : "Create a new account"}
      </button>
    </form>
  );
}
