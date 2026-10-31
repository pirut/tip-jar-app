import { useState } from "react";
import { View } from "react-native";
import { useMutation } from "convex/react";
import { useAuth, useUser } from "@clerk/expo";
import { api } from "../../../convex/_generated/api";
import { errorText } from "./format";
import { useColors } from "./theme";
import { Banner, Body, Btn, ErrorText, Field, LegalLinks, Title } from "./ui";

type Profile = { name: string; handle: string; jobTitle: string; workplace: string };

export function ProfileScreen({ initial, onDone, onCancel }: { initial?: Profile; onDone?: () => void; onCancel?: () => void }) {
  const c = useColors();
  const save = useMutation(api.workers.saveProfile);
  const remove = useMutation(api.workers.deleteAccount);
  const { signOut } = useAuth();
  const { user } = useUser();
  const [p, setP] = useState<Profile>({
    name: initial?.name ?? "",
    handle: initial?.handle ?? "",
    jobTitle: initial?.jobTitle ?? "Valet",
    workplace: initial?.workplace ?? "",
  });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const ready = !!p.name.trim() && p.handle.length >= 3;

  async function submit() {
    setError("");
    setBusy(true);
    try {
      await save({ name: p.name, handle: p.handle, jobTitle: p.jobTitle, workplace: p.workplace });
      onDone?.();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  async function deleteAccount() {
    setError("");
    setBusy(true);
    try {
      await remove({});
      await user?.delete();
      await signOut();
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  }

  return (
    <View style={{ gap: 14 }}>
      <Title>{initial ? "Edit your profile" : "Set up your tip page"}</Title>
      <Field label="Your name" value={p.name} maxLength={60} autoComplete="name" onChangeText={(name) => setP({ ...p, name })} />
      <Field label="Your link: tip.jrbussard.com/…" value={p.handle} maxLength={30} autoCapitalize="none" autoCorrect={false}
        onChangeText={(h) => setP({ ...p, handle: h.toLowerCase().replace(/[^a-z0-9-]/g, "") })} placeholder="marcus" />
      {!!initial && initial.handle !== p.handle && <Body small style={{ color: c.warn }}>Changing your link breaks any QR codes you've already printed.</Body>}
      <Field label="Job" value={p.jobTitle} maxLength={60} onChangeText={(jobTitle) => setP({ ...p, jobTitle })} />
      <Field label="Where you work" value={p.workplace} maxLength={80} onChangeText={(workplace) => setP({ ...p, workplace })} placeholder="The Harbor Hotel" />
      <ErrorText>{error}</ErrorText>
      <Btn kind="primary" title={busy ? "Saving…" : "Save"} onPress={submit} disabled={!ready || busy} />
      {!ready && <Body muted small>Add your name and a link of at least 3 characters.</Body>}
      {onCancel && <Btn kind="ghost" title="Cancel" onPress={onCancel} />}
      <Btn kind="ghost" title="Sign out" onPress={() => signOut()} />
      {initial && (confirmDelete ? (
        <Banner>
          <Body>Delete your account, tips and cash-out history? This can't be undone.</Body>
          <Btn title="Delete my account" disabled={busy} onPress={deleteAccount} />
          <Btn kind="ghost" title="Keep it" onPress={() => setConfirmDelete(false)} />
        </Banner>
      ) : (
        <Btn kind="ghost" title="Delete account" onPress={() => setConfirmDelete(true)} />
      ))}
      <LegalLinks />
    </View>
  );
}
