import { useState } from "react";
import { View } from "react-native";
import { useAuth } from "@clerk/expo";
import { useHostedAuth } from "@clerk/expo/hosted-auth";
import { Body, Btn, ErrorText, LegalLinks, Title } from "./ui";

export function AuthScreen() {
  const { startHostedAuth } = useHostedAuth();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function open(mode: "sign-up" | "sign-in") {
    setError("");
    setBusy(true);
    try {
      // Closing the browser sheet is a normal way out, so only a Clerk that isn't ready gets a message.
      const { authSessionResult } = await startHostedAuth({ mode });
      if (!authSessionResult) setError("Still getting ready. Try again in a moment.");
    } catch {
      setError("Couldn't sign you in. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={{ gap: 14, flex: 1, justifyContent: "center" }}>
      <Title>Start getting tipped</Title>
      <Body muted>Take tips by tap or QR code, and pool them with today's crew.</Body>
      <ErrorText>{error}</ErrorText>
      <Btn kind="primary" title="Create account" onPress={() => open("sign-up")} disabled={busy} />
      <Btn title="I already have an account" onPress={() => open("sign-in")} disabled={busy} />
      <LegalLinks />
    </View>
  );
}

// Clerk says signed in but the backend turned the session down, so the sign-in
// buttons would dead-end. Signing out is the one way back to a working state.
export function AuthStuckScreen() {
  const { signOut } = useAuth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <View style={{ gap: 14, flex: 1, justifyContent: "center" }}>
      <Title>We couldn't finish signing you in</Title>
      <Body muted>Sign out and try again. If this keeps happening, check your connection.</Body>
      <ErrorText>{error}</ErrorText>
      <Btn kind="primary" title={busy ? "Signing out…" : "Sign out"} disabled={busy} onPress={() => {
        setBusy(true);
        setError("");
        signOut().catch(() => setError("Couldn't sign out. Check your connection and try again.")).finally(() => setBusy(false));
      }} />
    </View>
  );
}
