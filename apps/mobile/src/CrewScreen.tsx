import { useEffect, useRef, useState } from "react";
import { Pressable, Share, Text, TextInput, View } from "react-native";
import { useMutation, useQuery } from "convex/react";
import QRCode from "react-native-qrcode-svg";
import { api } from "../../../convex/_generated/api";
import type { SplitMode } from "../../../convex/lib/split";
import { TIP_ORIGIN, errorText, money2, time } from "./format";
import { useColors } from "./theme";
import { Avatar, Banner, Big, Body, Btn, Card, DemoTag, ErrorText, Eyebrow, FONT, Field, Row, Seg, Title } from "./ui";

const MODES: [SplitMode, string][] = [["even", "Even"], ["hours", "Hours"], ["shares", "Shares"], ["custom", "Custom %"]];
const LENGTHS: ["4" | "8" | "12", string][] = [["4", "4 hours"], ["8", "8 hours"], ["12", "12 hours"]];
const MODE_NAME: Record<SplitMode, string> = { even: "split evenly", hours: "split by hours", shares: "split by shares", custom: "split by custom percents" };
const HELP: Record<SplitMode, string> = {
  even: "Same amount for everyone.",
  hours: "Based on time each person has been in the crew.",
  shares: "Weighted by role, like lead 1.5, valet 1, runner 0.5.",
  custom: "A fixed percent per person. Must add up to 100.",
};

function useRun() {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const run = async (fn: () => Promise<unknown>) => {
    if (inFlight.current) return; // a double tap must not fire the action twice
    inFlight.current = true;
    setError("");
    setBusy(true);
    try { await fn(); } catch (e) { setError(errorText(e)); } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  return { error, busy, run, setError };
}

export function CrewScreen() {
  const data = useQuery(api.crews.current);
  if (data === undefined) return <Body muted>Loading…</Body>;
  if (!data?.crew) return <NoCrew leftCrew={data?.leftCrew ?? null} />;
  return <InCrew crew={data.crew} />;
}

type Preview = { name: string; splitMode: SplitMode; closesAt: number; starterName: string; memberCount: number };

function NoCrew({ leftCrew }: { leftCrew: { name: string; closesAt: number } | null }) {
  const c = useColors();
  const last = useQuery(api.crews.lastClosed);
  const start = useMutation(api.crews.start);
  const join = useMutation(api.crews.join);
  const lookup = useMutation(api.crews.lookup);
  const joinForm = useRun();
  const startForm = useRun();
  const [code, setCode] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [name, setName] = useState("");
  const [mode, setMode] = useState<SplitMode>("even");
  const [length, setLength] = useState<"4" | "8" | "12">("8");
  const [starting, setStarting] = useState(false);

  const check = () => joinForm.run(async () => {
    const r = await lookup({ code });
    if (r.ok) setPreview(r.crew);
    else joinForm.setError(r.error);
  });
  const confirm = () => joinForm.run(async () => {
    const r = await join({ code });
    if (!r.ok) { setPreview(null); joinForm.setError(r.error); }
  });

  return (
    <View style={{ gap: 16 }}>
      <Eyebrow>Today's crew</Eyebrow>
      <Title>Pool tips with who you're working with</Title>
      <Body muted>Tips you get while in a crew go into one pool, split when it closes. Tips from before you join stay yours.</Body>
      {leftCrew && <Banner><Body small>You left {leftCrew.name}. Your share lands when it closes at {time(leftCrew.closesAt)}. Rejoin any time with the code.</Body></Banner>}
      {preview ? (
        <Card>
          <Eyebrow>Join this crew?</Eyebrow>
          <Big size={30}>{preview.name}</Big>
          <Body>Started by {preview.starterName} · {preview.memberCount} {preview.memberCount === 1 ? "person" : "people"}</Body>
          <Body muted small>Tips are {MODE_NAME[preview.splitMode]}. Closes at {time(preview.closesAt)}. Your tips go to the pool from now on.</Body>
          <ErrorText>{joinForm.error}</ErrorText>
          <Btn kind="primary" title={joinForm.busy ? "Joining…" : "Join crew"} disabled={joinForm.busy} onPress={confirm} />
          <Btn kind="ghost" title="Not this one" onPress={() => setPreview(null)} />
        </Card>
      ) : (
        <Card>
          <Eyebrow>Join with a code</Eyebrow>
          <TextInput accessibilityLabel="Crew join code" value={code} onChangeText={(t) => { joinForm.setError(""); setCode(t.replace(/\D/g, "").slice(0, 4)); }} keyboardType="number-pad" placeholder="····" placeholderTextColor={c.muted}
            style={{ fontSize: 28, letterSpacing: 12, textAlign: "center", borderWidth: 1, borderColor: c.control, borderRadius: 12, padding: 10, color: c.ink, fontFamily: FONT.mono }} />
          <ErrorText>{joinForm.error}</ErrorText>
          <Btn kind="primary" title={joinForm.busy ? "Checking…" : "Continue"} disabled={code.length !== 4 || joinForm.busy} onPress={check} />
        </Card>
      )}
      {starting ? (
        <Card>
          <Eyebrow>Start a crew</Eyebrow>
          <Field label="Crew name" value={name} maxLength={60} onChangeText={setName} placeholder="Harbor valet · Friday" />
          <Seg options={MODES} value={mode} onChange={setMode} />
          <Body muted small>{HELP[mode]} Only you can change this.</Body>
          <Body small>Closes after</Body>
          <Seg options={LENGTHS} value={length} onChange={setLength} />
          <ErrorText>{startForm.error}</ErrorText>
          <Btn kind="primary" title={startForm.busy ? "Starting…" : "Start crew"} disabled={startForm.busy} onPress={() => startForm.run(() => start({ name, splitMode: mode, closesInHours: Number(length) }))} />
        </Card>
      ) : (
        <Btn title="Start a new crew" onPress={() => setStarting(true)} />
      )}
      {last && (
        <View style={{ backgroundColor: c.brassSoft, borderRadius: 14, padding: 16, gap: 8 }}>
          <Row style={{ justifyContent: "space-between" }}><Eyebrow color={c.brassInk}>Last crew · {last.name}</Eyebrow><DemoTag /></Row>
          <Body small>Your share</Body>
          <Big size={30}>{money2(last.myPayoutCents)}</Big>
          {last.rows.map((r, i) => (
            <Row key={i} style={{ justifyContent: "space-between" }}><Row><Avatar name={r.name} size={28} /><Body>{r.name}</Body></Row><Body>{money2(r.payoutCents)}</Body></Row>
          ))}
        </View>
      )}
    </View>
  );
}

// Keeps what's being typed while the field has focus, then follows the live value again.
function NumberField({ value, label, onCommit }: { value: number; label: string; onCommit: (n: number) => void }) {
  const c = useColors();
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <TextInput
      accessibilityLabel={label}
      keyboardType="decimal-pad"
      value={draft ?? String(value)}
      onFocus={() => setDraft(String(value))}
      onChangeText={setDraft}
      onEndEditing={() => {
        if (draft !== null && draft !== "" && Number.isFinite(Number(draft)) && Number(draft) !== value) onCommit(Number(draft));
        setDraft(null);
      }}
      style={{ width: 60, minHeight: 44, borderWidth: 1, borderColor: c.control, borderRadius: 8, padding: 6, textAlign: "right", color: c.ink, fontFamily: FONT.body, fontSize: 16 }}
    />
  );
}

type CrewData = NonNullable<NonNullable<ReturnType<typeof useQuery<typeof api.crews.current>>>["crew"]>;

function InCrew({ crew }: { crew: CrewData }) {
  const c = useColors();
  const close = useMutation(api.crews.close);
  const leave = useMutation(api.crews.leave);
  const setSplitMode = useMutation(api.crews.setSplitMode);
  const setWeights = useMutation(api.crews.setMemberWeights);
  const removeMember = useMutation(api.crews.removeMember);
  const { error, busy, run } = useRun();
  const [confirming, setConfirming] = useState<"close" | "leave" | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [showQr, setShowQr] = useState(false);
  const [changedTo, setChangedTo] = useState<SplitMode | null>(null);
  const split = crew.splitMode as SplitMode;
  const field = split === "hours" ? "hours" : split === "shares" ? "shares" : split === "custom" ? "pct" : null;
  const activeCount = crew.members.filter((m) => !m.left).length;
  const pctTotal = crew.members.reduce((a, m) => a + m.pct, 0);
  const joinLink = `${TIP_ORIGIN}/app?join=${crew.code}`;

  // Members hear about split changes; only the starter can make them.
  const seenMode = useRef(split);
  useEffect(() => {
    if (seenMode.current !== split && !crew.iAmStarter) setChangedTo(split);
    seenMode.current = split;
  }, [split, crew.iAmStarter]);

  return (
    <View style={{ gap: 16 }}>
      <View style={{ backgroundColor: c.pool, borderRadius: 20, padding: 18, gap: 6 }}>
        <Row style={{ justifyContent: "space-between" }}><Eyebrow color={c.poolInk}>{crew.name}</Eyebrow><DemoTag /></Row>
        <Big size={56} color={c.poolInk}>{money2(crew.poolCents)}</Big>
        <Body small style={{ color: c.poolInk }}>in the pool · {activeCount} {activeCount === 1 ? "person" : "people"} · closes {time(crew.closesAt)}</Body>
        <Row style={{ justifyContent: "space-between", marginTop: 10, flexWrap: "wrap" }}>
          <View>
            <Eyebrow color={c.poolInk}>Join code</Eyebrow>
            <Text accessibilityLabel={`Join code ${crew.code.split("").join(" ")}`} style={{ color: c.poolInk, fontFamily: FONT.mono, fontSize: 34, letterSpacing: 5 }}>{crew.code}</Text>
          </View>
          <Row>
            <Pressable accessibilityRole="button" onPress={() => Share.share({ message: `Join my Tip Jar crew with code ${crew.code}: ${joinLink}` })} style={{ minHeight: 44, minWidth: 60, justifyContent: "center", alignItems: "center", borderRadius: 12, backgroundColor: "#ffffff26", paddingHorizontal: 12 }}>
              <Text style={{ color: c.poolInk, fontFamily: FONT.bodyBold }}>Share</Text>
            </Pressable>
            <Pressable accessibilityRole="button" accessibilityState={{ expanded: showQr }} onPress={() => setShowQr(!showQr)} style={{ minHeight: 44, minWidth: 44, justifyContent: "center", alignItems: "center", borderRadius: 12, backgroundColor: "#ffffff26", paddingHorizontal: 12 }}>
              <Text style={{ color: c.poolInk, fontFamily: FONT.bodyBold }}>QR</Text>
            </Pressable>
          </Row>
        </Row>
        {showQr && <View accessible accessibilityLabel="QR code to join this crew" style={{ alignSelf: "center", backgroundColor: "#fff", padding: 12, borderRadius: 14, marginTop: 8 }}><QRCode value={joinLink} size={160} /></View>}
      </View>
      {changedTo && <Banner><Body small>The crew starter changed the split: tips are now {MODE_NAME[changedTo]}.</Body><Btn title="OK" onPress={() => setChangedTo(null)} /></Banner>}
      <Seg options={MODES} value={split} disabled={!crew.iAmStarter} onChange={(k) => run(() => setSplitMode({ splitMode: k }))} />
      {!crew.splitValid
        ? (crew.iAmStarter ? <ErrorText>Percents add to {pctTotal}%. They need to add to 100%.</ErrorText> : <Body muted small>The crew starter is setting percents. Shares appear once they add up to 100%.</Body>)
        : crew.evenFallback
          ? <Body muted small>{split === "hours" ? "Hours are still at zero, so for now this splits evenly." : "All weights are zero, so this splits evenly."}</Body>
          : <Body muted small>{HELP[split]} {crew.iAmStarter ? "Only you can change this." : "Only the person who started the crew can change this."}</Body>}
      <Card>
        {crew.members.map((m) => (
          <View key={m.memberId} style={{ gap: 4 }}>
            <Row>
              <Avatar name={m.name} />
              <View style={{ flex: 1 }}>
                <Body>{m.name}{m.isMe ? " (you)" : ""}</Body>
                <Body muted small>{[m.jobTitle, m.isStarter ? "started crew" : "", m.left ? "left, share pending" : ""].filter(Boolean).join(" · ")}</Body>
              </View>
              {field && (crew.iAmStarter ? (
                <NumberField value={m[field]} label={`${field === "pct" ? "Percent" : field === "hours" ? "Hours" : "Shares"} for ${m.name}`} onCommit={(n) => run(() => setWeights({ memberId: m.memberId, [field]: n }))} />
              ) : <Body muted small>{m[field]}{field === "pct" ? "%" : field === "hours" ? "h" : "×"}</Body>)}
              <Text style={{ color: c.ink, fontFamily: FONT.bodyBold, minWidth: 68, textAlign: "right", fontVariant: ["tabular-nums"] }}>
                {m.projectedCents === null ? "—" : money2(m.projectedCents)}
              </Text>
            </Row>
            {crew.iAmStarter && !m.isMe && (removing === m.memberId ? (
              <Banner>
                <Body small>Remove {m.name.split(" ")[0]}? Their tips go back to them.</Body>
                <Btn title="Remove" disabled={busy} onPress={() => run(() => removeMember({ memberId: m.memberId })).then(() => setRemoving(null))} />
                <Btn kind="ghost" title="Keep" onPress={() => setRemoving(null)} />
              </Banner>
            ) : (
              <Pressable accessibilityRole="button" accessibilityLabel={`Remove ${m.name} from crew`} onPress={() => setRemoving(m.memberId)} style={{ minHeight: 44, justifyContent: "center", alignSelf: "flex-start", marginLeft: 44 }}>
                <Text style={{ color: c.muted, fontFamily: FONT.bodyBold, fontSize: 13, textDecorationLine: "underline" }}>Remove</Text>
              </Pressable>
            ))}
          </View>
        ))}
      </Card>
      <ErrorText>{error}</ErrorText>
      {crew.iAmStarter ? (
        confirming === "close" ? (
          <Banner>
            <Body>Close the crew and pay everyone their share now? This can't be undone.</Body>
            <Btn kind="primary" title={busy ? "Closing…" : "Close and split"} disabled={busy} onPress={() => run(() => close({}))} />
            <Btn kind="ghost" title="Keep crew open" onPress={() => setConfirming(null)} />
          </Banner>
        ) : (
          <Btn kind="primary" title="Close crew and split now" onPress={() => setConfirming("close")} />
        )
      ) : confirming === "leave" ? (
        <Banner>
          <Body>Leave this crew? You still get your share when it closes, and new tips stay yours.</Body>
          <Btn title="Leave crew" disabled={busy} onPress={() => run(() => leave({}))} />
          <Btn kind="ghost" title="Stay" onPress={() => setConfirming(null)} />
        </Banner>
      ) : (
        <Btn kind="ghost" title="Leave crew" onPress={() => setConfirming("leave")} />
      )}
    </View>
  );
}

export function useInCrew(): boolean | undefined {
  const data = useQuery(api.crews.current);
  return data === undefined ? undefined : !!data?.crew;
}
