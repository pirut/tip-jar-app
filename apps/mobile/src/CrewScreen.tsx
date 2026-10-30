import { useState } from "react";
import { Text, TextInput, View } from "react-native";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import type { SplitMode } from "../../../convex/lib/split";
import { errorText, money2, time } from "./format";
import { useColors } from "./theme";
import { Avatar, Body, Btn, Card, ErrorText, Eyebrow, Field, Row, Seg, Title } from "./ui";

const MODES: [SplitMode, string][] = [["even", "Even"], ["hours", "Hours"], ["shares", "Shares"], ["custom", "Custom %"]];
const HELP: Record<SplitMode, string> = {
  even: "Same amount for everyone.",
  hours: "Based on time each person has been in the crew.",
  shares: "Weighted by role, like lead 1.5, valet 1, runner 0.5.",
  custom: "A fixed percent per person. Must add up to 100.",
};

export function CrewScreen() {
  const c = useColors();
  const data = useQuery(api.crews.current);
  const last = useQuery(api.crews.lastClosed);
  const start = useMutation(api.crews.start);
  const join = useMutation(api.crews.join);
  const leave = useMutation(api.crews.leave);
  const close = useMutation(api.crews.close);
  const setSplitMode = useMutation(api.crews.setSplitMode);
  const setWeights = useMutation(api.crews.setMemberWeights);
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [mode, setMode] = useState<SplitMode>("even");
  const [starting, setStarting] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState("");
  const run = async (fn: () => Promise<unknown>) => {
    setError("");
    try { await fn(); } catch (e) { setError(errorText(e)); }
  };

  if (data === undefined) return <Body muted>Loading…</Body>;
  const crew = data?.crew;

  if (!crew)
    return (
      <View style={{ gap: 16 }}>
        <Eyebrow>Today's crew</Eyebrow>
        <Title>Pool tips with who you're working with</Title>
        <Body muted>Tips you get while in a crew go into one pool, split when it closes. Tips from before you join stay yours.</Body>
        <Card>
          <Eyebrow>Join with a code</Eyebrow>
          <TextInput value={code} onChangeText={(t) => setCode(t.replace(/\D/g, "").slice(0, 4))} keyboardType="number-pad" placeholder="····" placeholderTextColor={c.muted}
            style={{ fontSize: 28, letterSpacing: 12, textAlign: "center", borderWidth: 1, borderColor: c.line, borderRadius: 12, padding: 10, color: c.ink }} />
          <Btn kind="primary" title="Join crew" disabled={code.length !== 4} onPress={() => run(() => join({ code }))} />
        </Card>
        {starting ? (
          <Card>
            <Eyebrow>Start a crew</Eyebrow>
            <Field label="Crew name" value={name} onChangeText={setName} placeholder="Harbor valet · Friday" />
            <Seg options={MODES} value={mode} onChange={setMode} />
            <Body muted small>{HELP[mode]} Only you can change this.</Body>
            <Btn kind="primary" title="Start crew (closes in 8 hours)" onPress={() => run(() => start({ name, splitMode: mode, closesInHours: 8 }))} />
          </Card>
        ) : (
          <Btn title="Start a new crew" onPress={() => setStarting(true)} />
        )}
        <ErrorText>{error}</ErrorText>
        {last && (
          <Card>
            <Eyebrow>Last crew · {last.name}</Eyebrow>
            <Body>Your share: {money2(last.myPayoutCents)}</Body>
            {last.rows.map((r, i) => (
              <Row key={i} style={{ justifyContent: "space-between" }}><Body>{r.name}</Body><Body>{money2(r.payoutCents)}</Body></Row>
            ))}
          </Card>
        )}
      </View>
    );

  const split = crew.splitMode as SplitMode;
  const field = split === "hours" ? "hours" : split === "shares" ? "shares" : split === "custom" ? "pct" : null;

  return (
    <View style={{ gap: 16 }}>
      <View style={{ backgroundColor: c.green, borderRadius: 20, padding: 18, gap: 6 }}>
        <Row style={{ justifyContent: "space-between" }}>
          <Text style={{ color: c.greenInk, opacity: 0.75, fontSize: 11, letterSpacing: 1.2, textTransform: "uppercase" }}>{crew.name}</Text>
          <Text style={{ color: c.greenInk, opacity: 0.75, fontSize: 11, letterSpacing: 1.2 }}>CODE {crew.code}</Text>
        </Row>
        <Text style={{ color: c.greenInk, fontSize: 56, fontWeight: "900", fontVariant: ["tabular-nums"] }}>{money2(crew.poolCents)}</Text>
        <Text style={{ color: c.greenInk, fontSize: 13 }}>in the pool · {crew.members.length} people · closes {time(crew.closesAt)}</Text>
      </View>
      <Seg options={MODES} value={split} disabled={!crew.iAmStarter} onChange={(k) => run(() => setSplitMode({ splitMode: k }))} />
      {crew.splitValid
        ? <Body muted small>{HELP[split]} {crew.iAmStarter ? "Only you can change this." : "Only the person who started the crew can change this."}</Body>
        : <ErrorText>Percents need to add up to 100%.</ErrorText>}
      <Card>
        {crew.members.map((m) => (
          <Row key={m.memberId}>
            <Avatar name={m.name} />
            <View style={{ flex: 1 }}>
              <Body>{m.name}{m.isMe ? " (you)" : ""}</Body>
              <Body muted small>{[m.jobTitle, m.isStarter ? "started crew" : ""].filter(Boolean).join(" · ")}</Body>
            </View>
            {field && (crew.iAmStarter ? (
              <TextInput
                key={`${field}-${m[field]}`}
                defaultValue={String(m[field])}
                keyboardType="decimal-pad"
                onEndEditing={(e) => run(() => setWeights({ memberId: m.memberId, [field]: Number(e.nativeEvent.text) }))}
                style={{ width: 60, borderWidth: 1, borderColor: c.line, borderRadius: 8, padding: 6, textAlign: "right", color: c.ink }}
              />
            ) : <Body muted small>{m[field]}{field === "pct" ? "%" : field === "hours" ? "h" : "×"}</Body>)}
            <Text style={{ color: c.ink, fontWeight: "600", minWidth: 72, textAlign: "right", fontVariant: ["tabular-nums"] }}>
              {m.projectedCents === null ? "—" : money2(m.projectedCents)}
            </Text>
          </Row>
        ))}
      </Card>
      <ErrorText>{error}</ErrorText>
      {crew.iAmStarter ? (
        confirming ? (
          <Card>
            <Body>Close the crew and pay everyone their share now?</Body>
            <Btn kind="primary" title="Close and split" onPress={() => run(() => close({})).then(() => setConfirming(false))} />
            <Btn kind="ghost" title="Cancel" onPress={() => setConfirming(false)} />
          </Card>
        ) : (
          <Btn kind="primary" title="Close crew and split now" disabled={!crew.splitValid} onPress={() => setConfirming(true)} />
        )
      ) : (
        <Btn kind="ghost" title="Leave crew" onPress={() => run(() => leave({}))} />
      )}
    </View>
  );
}

export function useInCrew(): boolean | undefined {
  const data = useQuery(api.crews.current);
  return data === undefined ? undefined : !!data?.crew;
}

