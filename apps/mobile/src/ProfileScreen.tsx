import { useState } from "react";
import { View } from "react-native";
import { useMutation, useQuery } from "convex/react";
import { useAuth, useUser } from "@clerk/expo";
import { api } from "../../../convex/_generated/api";
import { errorText, time } from "./format";
import { useColors } from "./theme";
import { Banner, Body, Btn, ErrorText, Field, LegalLinks, Loading, Title } from "./ui";

type Profile = { name: string; handle: string; jobTitle: string; workplace: string };

export function ProfileScreen({ initial, onDone, onCancel }: { initial?: Profile; onDone?: () => void; onCancel?: () => void }) {
  const c = useColors();
  const save = useMutation(api.workers.saveProfile);
  const remove = useMutation(api.workers.deleteAccount);
  const crew = useQuery(api.crews.current, initial ? {} : "skip");
  const { signOut } = useAuth();
  const { user } = useUser();
  const [p, setP] = useState<Profile>({
    name: initial?.name ?? "",
    handle: initial?.handle ?? "",
    jobTitle: initial?.jobTitle ?? "Valet",
    workplace: initial?.workplace ?? "",
  });
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  // Tip Jar's data is gone but the Clerk sign-in isn't. Retrying must skip the data step, which would now fail.
  const [partlyDeleted, setPartlyDeleted] = useState(false);
  const [signOutError, setSignOutError] = useState("");
  const ready = !!p.name.trim() && p.handle.length >= 3;
  const crewBlock = crew?.crew
    ? (crew.crew.iAmStarter ? "You started an open crew. Close it before deleting your account." : "You're in a crew. Leave it, and wait for it to close, before deleting your account.")
    : crew?.leftCrew
      ? `You left ${crew.leftCrew.name}, and your share is paid when it closes at ${time(crew.leftCrew.closesAt)}. You can delete your account after that.`
      : "";

  async function submit() {
    setError("");
    setSaving(true);
    try {
      await save({ name: p.name, handle: p.handle, jobTitle: p.jobTitle, workplace: p.workplace });
      onDone?.();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSaving(false);
    }
  }

  function logOut() {
    setSignOutError("");
    signOut().catch(() => setSignOutError("Couldn't sign out. Check your connection and try again."));
  }

  // Runs both steps for a full delete, or only the sign-in step when no Tip Jar data is left.
  async function deleteAccount(dataAlreadyGone: boolean) {
    setDeleteError("");
    setDeleting(true);
    if (!dataAlreadyGone) {
      try {
        await remove({});
      } catch (e) {
        setDeleteError(errorText(e));
        setDeleting(false);
        return;
      }
    }
    if (!dataAlreadyGone) setPartlyDeleted(true);
    try {
      await user?.delete();
    } catch {
      setDeleting(false);
      setDeleteError("We couldn't remove your sign-in account. Check your connection and try again.");
      return;
    }
    // The account is gone at this point, so a sign-out failure has nothing left to report.
    await signOut().catch(() => {});
  }

  if (partlyDeleted)
    return deleting ? <Loading label="Deleting your account…" /> : (
      <View style={{ gap: 14 }}>
        <Title>Your account is only partly deleted</Title>
        <Body>Your Tip Jar profile, tips and cash-out history are deleted. Your sign-in account still exists, so this email can still sign in. If trying again keeps failing, sign out, sign back in, and choose Delete account on the setup screen.</Body>
        <ErrorText>{deleteError}</ErrorText>
        <Btn kind="danger" title="Try again" onPress={() => deleteAccount(true)} />
        <Btn kind="ghost" title="Sign out" onPress={logOut} />
        <ErrorText>{signOutError}</ErrorText>
      </View>
    );

  if (deleting) return <Loading label="Deleting your account…" />;

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
      <Btn kind="primary" title={saving ? "Saving…" : "Save"} onPress={submit} disabled={!ready || saving} />
      {!ready && <Body muted small>Add your name and a link of at least 3 characters.</Body>}
      {onCancel && <Btn kind="ghost" title="Cancel" disabled={saving} onPress={onCancel} />}
      <Btn kind="ghost" title="Sign out" onPress={logOut} />
      <ErrorText>{signOutError}</ErrorText>
      {confirmDelete ? (
        <Banner>
          <Body>{initial
            ? "Delete your account, tips and cash-out history? This can't be undone."
            : "Delete your sign-in account? You have no Tip Jar profile yet, so that's all there is to remove. This can't be undone."}</Body>
          <ErrorText>{deleteError}</ErrorText>
          <Btn kind="danger" title="Delete my account" onPress={() => deleteAccount(!initial)} />
          <Btn kind="ghost" title="Keep it" onPress={() => { setConfirmDelete(false); setDeleteError(""); }} />
        </Banner>
      ) : (
        <View style={{ gap: 4 }}>
          <Btn kind="ghost" title="Delete account" disabled={!!crewBlock} onPress={() => setConfirmDelete(true)} />
          {!!crewBlock && <Body muted small style={{ textAlign: "center" }}>{crewBlock}</Body>}
        </View>
      )}
      <LegalLinks />
    </View>
  );
}
