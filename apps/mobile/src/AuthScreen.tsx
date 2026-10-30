import { useState } from "react";
import { View } from "react-native";
import { useAuthActions } from "@convex-dev/auth/react";
import { Btn, ErrorText, Field, Title } from "./ui";

export function AuthScreen() {
  const { signIn } = useAuthActions();
  const [flow, setFlow] = useState<"signUp" | "signIn">("signUp");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit() {
    setError("");
    setBusy(true);
    try {
      await signIn("password", { email, password, flow });
    } catch {
      setError(flow === "signIn" ? "That email and password don't match." : "Couldn't create the account. Use a password of 8+ characters, or sign in.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={{ gap: 14 }}>
      <Title>{flow === "signUp" ? "Start getting tipped" : "Welcome back"}</Title>
      <Field label="Email" value={email} onChangeText={setEmail} autoCapitalize="none" keyboardType="email-address" autoComplete="email" />
      <Field label="Password" value={password} onChangeText={setPassword} secureTextEntry autoComplete={flow === "signUp" ? "new-password" : "current-password"} />
      <ErrorText>{error}</ErrorText>
      <Btn kind="primary" title={flow === "signUp" ? "Create account" : "Sign in"} onPress={submit} disabled={busy || !email || password.length < 8} />
      <Btn kind="ghost" title={flow === "signUp" ? "I already have an account" : "Create a new account"} onPress={() => setFlow(flow === "signUp" ? "signIn" : "signUp")} />
    </View>
  );
}
