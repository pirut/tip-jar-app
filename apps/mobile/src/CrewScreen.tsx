import { useEffect, useRef, useState } from "react";
import { Keyboard, Pressable, StyleSheet, Text, View } from "react-native";
import { useMutation, useQuery } from "convex/react";
import QRCode from "react-native-qrcode-svg";
import { api } from "../../../convex/_generated/api";
import type { SplitMode } from "../../../convex/lib/split";
import { TIP_ORIGIN, dateTime, errorText, money2, time } from "./format";
import { useColors } from "./theme";
import { Avatar, Banner, Big, Body, Btn, Card, DemoTag, ErrorText, Eyebrow, FONT, Field, Input, Loading, Row, Seg, Title, shareText } from "./ui";

const MODES: [SplitMode, string][] = [["even", "Even"], ["hours", "Hours"], ["shares", "Shares"], ["custom", "Custom %"]];
const LENGTHS: ["4" | "8" | "12", string][] = [["4", "4 hours"], ["8", "8 hours"], ["12", "12 hours"]];
const MODE_NAME: Record<SplitMode, string> = { even: "split evenly", hours: "split by hours", shares: "split by shares", custom: "split by custom percents" };
const HELP: Record<SplitMode, string> = {
  even: "Same amount for everyone.",
  hours: "Based on time each person has been in the crew.",
  shares: "Weighted by role, like lead 1.5, valet 1, runner 0.5.",
  custom: "A fixed percent per person. Must add up to 100, or the pool splits evenly when the crew reaches its closing time.",
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
  if (data === undefined) return <Loading />;
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
          <Title>{preview.name}</Title>
          <Body>Started by {preview.starterName} · {preview.memberCount} {preview.memberCount === 1 ? "person" : "people"}</Body>
          <Body muted small>Tips are {MODE_NAME[preview.splitMode]}. Closes at {time(preview.closesAt)}. Your tips go to the pool from now on.</Body>
          {preview.splitMode === "custom" && <Body small>If the percents don't add up to 100% by closing time, the pool splits evenly.</Body>}
          <ErrorText>{joinForm.error}</ErrorText>
          <Btn kind="primary" title={joinForm.busy ? "Joining…" : "Join crew"} disabled={joinForm.busy} onPress={confirm} />
          <Btn kind="ghost" title="Not this one" disabled={joinForm.busy} onPress={() => { setPreview(null); joinForm.setError(""); }} />
        </Card>
      ) : (
        <Card>
          <Eyebrow>Join with a code</Eyebrow>
          <Input accessibilityLabel="Crew join code" value={code} keyboardType="number-pad" autoComplete="off" importantForAutofill="no" placeholder="····" maxFontSizeMultiplier={1.5}
            onChangeText={(t) => {
              const digits = t.replace(/\D/g, "").slice(0, 4);
              joinForm.setError("");
              setCode(digits);
              if (digits.length === 4) Keyboard.dismiss(); // the number pad has no return key to reveal Continue
            }}
            style={{ fontSize: 28, letterSpacing: 12, textAlign: "center", fontFamily: FONT.bodyBold, fontVariant: ["tabular-nums"] }} />
          <ErrorText>{joinForm.error}</ErrorText>
          <Btn kind="primary" title={joinForm.busy ? "Checking…" : "Continue"} disabled={code.length !== 4 || joinForm.busy} onPress={check} />
        </Card>
      )}
      {starting ? (
        <Card>
          <Eyebrow>Start a crew</Eyebrow>
          <Field label="Crew name (optional)" value={name} maxLength={60} onChangeText={setName} placeholder="Harbor valet · Friday" />
          <Seg label="How tips split" options={MODES} value={mode} onChange={setMode} />
          <Body muted small>{HELP[mode]} Only you can change this.</Body>
          <Body small>Closes after</Body>
          <Seg label="Closes after" options={LENGTHS} value={length} onChange={setLength} />
          <ErrorText>{startForm.error}</ErrorText>
          <Btn kind="primary" title={startForm.busy ? "Starting…" : "Start crew"} disabled={startForm.busy} onPress={() => startForm.run(() => start({ name, splitMode: mode, closesInHours: Number(length) }))} />
          <Btn kind="ghost" title="Cancel" disabled={startForm.busy} onPress={() => { setStarting(false); startForm.setError(""); }} />
        </Card>
      ) : (
        <Btn title="Start a new crew" onPress={() => setStarting(true)} />
      )}
      {last && (
        <Card>
          <Row style={{ justifyContent: "space-between" }}><Eyebrow>Last crew · {last.name}</Eyebrow><DemoTag /></Row>
          <Body small muted>Your share{last.closedAt ? `, closed ${dateTime(last.closedAt)}` : ""}</Body>
          <Big size={30}>{money2(last.myPayoutCents)}</Big>
          {last.rows.map((r, i) => (
            <Row key={i} style={{ justifyContent: "space-between" }}>
              <Row style={{ flexShrink: 1 }}><Avatar name={r.name} size={28} /><Body>{r.name}</Body></Row>
              <Text style={{ color: c.ink, fontFamily: FONT.bodyBold, fontVariant: ["tabular-nums"] }}>{money2(r.payoutCents)}</Text>
            </Row>
          ))}
        </Card>
      )}
    </View>
  );
}

// Keeps what's being typed while the field has focus, then follows the live value again.
function NumberField({ value, label, onCommit }: { value: number; label: string; onCommit: (n: number) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <Input
      accessibilityLabel={label}
      keyboardType="decimal-pad"
      maxFontSizeMultiplier={1.4}
      value={draft ?? String(value)}
      onFocus={() => setDraft(String(value))}
      onChangeText={setDraft}
      onEndEditing={() => {
        const n = Number((draft ?? "").replace(",", "."));
        if (draft !== null && draft !== "" && Number.isFinite(n) && n !== value) onCommit(n);
        setDraft(null);
      }}
      style={{ width: 72, minHeight: 44, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 6, textAlign: "right" }}
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
  const edit = useRun(); // split, weights and removals, which report above the member list
  const finish = useRun(); // closing and leaving, which report inside their confirmation
  const [confirming, setConfirming] = useState<"close" | "leave" | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [showQr, setShowQr] = useState(false);
  const [changedTo, setChangedTo] = useState<SplitMode | null>(null);
  const split = crew.splitMode as SplitMode;
  const field = split === "hours" ? "hours" : split === "shares" ? "shares" : split === "custom" ? "pct" : null;
  const fieldName = field === "pct" ? "Percent" : field === "hours" ? "Hours" : "Shares";
  const fieldUnit = field === "pct" ? "%" : field === "hours" ? "h" : "×";
  const activeCount = crew.members.filter((m) => !m.left).length;
  const pctTotal = crew.members.reduce((a, m) => a + m.pct, 0);
  const joinLink = `${TIP_ORIGIN}/app?join=${crew.code}`;
  const closesEvenly = `If the percents still don't add up to 100% at ${time(crew.closesAt)}, the crew closes on its own and the pool splits evenly.`;

  // Members hear about split changes; only the starter can make them.
  const seenMode = useRef(split);
  useEffect(() => {
    if (seenMode.current !== split && !crew.iAmStarter) setChangedTo(split);
    seenMode.current = split;
  }, [split, crew.iAmStarter]);

  // Percents can stop adding to 100 while the confirmation is open; closing is blocked until they do.
  useEffect(() => {
    if (!crew.splitValid && confirming === "close") setConfirming(null);
  }, [crew.splitValid, confirming]);

  const heroButton = { minHeight: 44, justifyContent: "center", alignItems: "center", borderRadius: 12, backgroundColor: "#ffffff26", paddingHorizontal: 12 } as const;

  return (
    <View style={{ gap: 16 }}>
      <View style={{ backgroundColor: c.pool, borderRadius: 20, padding: 18, gap: 6 }}>
        <Row style={{ justifyContent: "space-between" }}><Eyebrow color={c.poolInk}>{crew.name}</Eyebrow><DemoTag /></Row>
        <Big size={56} color={c.poolInk}>{money2(crew.poolCents)}</Big>
        <Body small style={{ color: c.poolInk }}>in the pool · {activeCount} {activeCount === 1 ? "person" : "people"} · closes {time(crew.closesAt)}</Body>
        <Row style={{ justifyContent: "space-between", marginTop: 10, flexWrap: "wrap" }}>
          <View>
            <Eyebrow color={c.poolInk}>Join code</Eyebrow>
            <Text accessibilityLabel={`Join code ${crew.code.split("").join(" ")}`} maxFontSizeMultiplier={1.4} style={{ color: c.poolInk, fontFamily: FONT.bodyBold, fontSize: 34, letterSpacing: 5, fontVariant: ["tabular-nums"] }}>{crew.code}</Text>
          </View>
          <Row>
            <Pressable accessibilityRole="button" accessibilityLabel="Share join code" onPress={() => shareText(`Join my Tip Jar crew with code ${crew.code}: ${joinLink}`)} style={({ pressed }) => [heroButton, { opacity: pressed ? 0.7 : 1 }]}>
              <Text style={{ color: c.poolInk, fontFamily: FONT.bodyBold }}>Share</Text>
            </Pressable>
            <Pressable accessibilityRole="button" accessibilityLabel={showQr ? "Hide join QR code" : "Show join QR code"} accessibilityState={{ expanded: showQr }} onPress={() => setShowQr(!showQr)} style={({ pressed }) => [heroButton, { opacity: pressed ? 0.7 : 1 }]}>
              <Text style={{ color: c.poolInk, fontFamily: FONT.bodyBold }}>{showQr ? "Hide QR" : "QR"}</Text>
            </Pressable>
          </Row>
        </Row>
        {showQr && (
          <View style={{ alignItems: "center", gap: 8, marginTop: 8 }}>
            <View accessible accessibilityRole="image" accessibilityLabel="QR code to join this crew" style={{ backgroundColor: "#fff", padding: 12, borderRadius: 14 }}><QRCode value={joinLink} size={160} /></View>
            <Body small style={{ color: c.poolInk, textAlign: "center" }}>Scanning opens Tip Jar on the web. In the app, enter the code instead.</Body>
          </View>
        )}
      </View>
      {changedTo && <Banner><Body small>The crew starter changed the split: tips are now {MODE_NAME[changedTo]}.</Body><Btn title="OK" onPress={() => setChangedTo(null)} /></Banner>}
      <Seg label="How tips split" options={MODES} value={split} disabled={!crew.iAmStarter || edit.busy} onChange={(k) => edit.run(() => setSplitMode({ splitMode: k }))} />
      {!crew.splitValid ? (
        <Banner>
          {crew.iAmStarter
            ? <ErrorText>Percents add to {pctTotal}%. Set them to 100% before you can close the crew.</ErrorText>
            : <Body small>The crew starter is setting percents, which add to {pctTotal}% so far. Shares appear once they add up to 100%.</Body>}
          <Body small>{closesEvenly}</Body>
        </Banner>
      ) : crew.evenFallback
        ? <Body muted small>{split === "hours" ? "Hours are still at zero, so for now this splits evenly." : "All weights are zero, so this splits evenly."}</Body>
        : <Body muted small>{split === "custom" ? "A fixed percent per person." : HELP[split]} {crew.iAmStarter ? "Only you can change this." : "Only the person who started the crew can change this."}</Body>}
      {edit.busy && <Body muted small>Saving…</Body>}
      <ErrorText>{edit.error}</ErrorText>
      {crew.iAmStarter && crew.members.length === 1 && <Body muted small>It's just you so far. Share the join code to bring people in.</Body>}
      <Card>
        {crew.members.map((m, i) => (
          <View key={m.memberId} style={{ gap: 6, paddingTop: i ? 10 : 0, borderTopWidth: i ? StyleSheet.hairlineWidth : 0, borderTopColor: c.line }}>
            <Row>
              <Avatar name={m.name} />
              <View style={{ flex: 1 }}>
                <Body>{m.name}{m.isMe ? " (you)" : ""}</Body>
                <Body muted small>{[m.jobTitle, m.isStarter ? "started crew" : "", m.left ? "left, share pending" : "", field && !crew.iAmStarter ? `${m[field]}${fieldUnit}` : ""].filter(Boolean).join(" · ")}</Body>
              </View>
              <Text style={{ color: c.ink, fontFamily: FONT.bodyBold, textAlign: "right", fontVariant: ["tabular-nums"] }}>
                {m.projectedCents === null ? "—" : money2(m.projectedCents)}
              </Text>
            </Row>
            {crew.iAmStarter && (!m.isMe || field) && (
              <Row style={{ justifyContent: "space-between", flexWrap: "wrap", marginLeft: 44 }}>
                {m.isMe ? <View /> : (
                  <Pressable accessibilityRole="button" accessibilityLabel={`Remove ${m.name} from crew`} onPress={() => setRemoving(m.memberId)} style={({ pressed }) => ({ minHeight: 44, justifyContent: "center", opacity: pressed ? 0.7 : 1 })}>
                    <Text style={{ color: c.muted, fontFamily: FONT.bodyBold, fontSize: 13, textDecorationLine: "underline" }}>Remove</Text>
                  </Pressable>
                )}
                {field && (
                  <Row style={{ gap: 8 }}>
                    <Body muted small>{fieldName}</Body>
                    <NumberField value={m[field]} label={`${fieldName} for ${m.name}`} onCommit={(n) => edit.run(() => setWeights({ memberId: m.memberId, [field]: n }))} />
                  </Row>
                )}
              </Row>
            )}
            {removing === m.memberId && (
              <View style={{ gap: 8, marginLeft: 44 }}>
                <Body small>Remove {m.name.split(" ")[0]}? Their own tips go back to them, and they get no share of this pool.</Body>
                <Row>
                  <Btn kind="danger" title="Remove" style={{ flex: 1 }} disabled={edit.busy} onPress={() => edit.run(() => removeMember({ memberId: m.memberId })).then(() => setRemoving(null))} />
                  <Btn kind="ghost" title="Keep" style={{ flex: 1 }} disabled={edit.busy} onPress={() => setRemoving(null)} />
                </Row>
              </View>
            )}
          </View>
        ))}
      </Card>
      {crew.iAmStarter ? (
        confirming === "close" ? (
          <Banner>
            <Body>Close the crew and pay everyone their share now? This can't be undone.</Body>
            {crew.evenFallback && <Body small>{split === "hours" ? "Hours are still at zero" : "All weights are zero"}, so the pool will split evenly.</Body>}
            <ErrorText>{finish.error}</ErrorText>
            <Btn kind="primary" title={finish.busy ? "Closing…" : "Close and split (demo)"} disabled={finish.busy} onPress={() => finish.run(() => close({}))} />
            <Btn kind="ghost" title="Keep crew open" disabled={finish.busy} onPress={() => { setConfirming(null); finish.setError(""); }} />
          </Banner>
        ) : (
          <Btn kind="primary" title="Close crew and split now" disabled={!crew.splitValid} onPress={() => setConfirming("close")} />
        )
      ) : confirming === "leave" ? (
        <Banner>
          <Body>Leave this crew? You still get your share when it closes, and new tips stay yours.</Body>
          {!crew.splitValid && <Body small>{closesEvenly}</Body>}
          <ErrorText>{finish.error}</ErrorText>
          <Btn kind="danger" title={finish.busy ? "Leaving…" : "Leave crew"} disabled={finish.busy} onPress={() => finish.run(() => leave({}))} />
          <Btn kind="ghost" title="Stay" disabled={finish.busy} onPress={() => { setConfirming(null); finish.setError(""); }} />
        </Banner>
      ) : (
        <Btn kind="ghost" title="Leave crew" onPress={() => setConfirming("leave")} />
      )}
    </View>
  );
}

export function useInCrew(enabled: boolean): boolean | undefined {
  const data = useQuery(api.crews.current, enabled ? {} : "skip");
  return data === undefined ? undefined : !!data?.crew;
}
