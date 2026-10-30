import { useState } from "react";
import { View } from "react-native";
import { useMutation } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { errorText } from "./format";
import { Body, Btn, ErrorText, Field, Title } from "./ui";

type Profile = { name: string; handle: string; jobTitle: string; workplace: string };

export function ProfileScreen({ initial, onDone }: { initial?: Profile; onDone?: () => void }) {
  const save = useMutation(api.workers.saveProfile);
  const [p, setP] = useState<Profile>(initial ?? { name: "", handle: "", jobTitle: "Valet", workplace: "" });
  const [error, setError] = useState("");

  async function submit() {
    setError("");
    try {
      await save(p);
      onDone?.();
    } catch (e) {
      setError(errorText(e));
    }
  }

  return (
    <View style={{ gap: 14 }}>
      <Title>{initial ? "Edit your profile" : "Set up your tip page"}</Title>
      <Field label="Your name" value={p.name} onChangeText={(name) => setP({ ...p, name })} />
      <Field label="Your link: tip.jrbussard.com/…" value={p.handle} autoCapitalize="none"
        onChangeText={(h) => setP({ ...p, handle: h.toLowerCase().replace(/[^a-z0-9-]/g, "") })} placeholder="marcus" />
      <Field label="Job" value={p.jobTitle} onChangeText={(jobTitle) => setP({ ...p, jobTitle })} />
      <Field label="Where you work" value={p.workplace} onChangeText={(workplace) => setP({ ...p, workplace })} placeholder="The Harbor Hotel" />
      <ErrorText>{error}</ErrorText>
      <Btn kind="primary" title="Save" onPress={submit} disabled={!p.name || p.handle.length < 3} />
      <Body muted small>Guests can tip you at your link or its QR code, even without the app.</Body>
    </View>
  );
}
