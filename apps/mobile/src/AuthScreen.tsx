import { useState } from "react";
import { View } from "react-native";
import { useHostedAuth } from "@clerk/expo/hosted-auth";
import { Btn, ErrorText, Title } from "./ui";

export function AuthScreen() {
  const { startHostedAuth } = useHostedAuth();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function open(mode: "sign-up" | "sign-in") {
    setError("");
    setBusy(true);
    try {
      await startHostedAuth({ mode });
    } catch {
      setError("Couldn't sign you in. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={{ gap: 14 }}>
      <Title>Start getting tipped</Title>
      <ErrorText>{error}</ErrorText>
      <Btn kind="primary" title="Create account" onPress={() => open("sign-up")} disabled={busy} />
      <Btn kind="ghost" title="I already have an account" onPress={() => open("sign-in")} disabled={busy} />
    </View>
  );
}
