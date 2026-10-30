import { useState } from "react";
import { View } from "react-native";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { errorText, money2 } from "./format";
import { useColors } from "./theme";
import { Big, Body, Btn, Card, DemoTag, ErrorText, Eyebrow, Row } from "./ui";

export function EarningsScreen() {
  const c = useColors();
  const s = useQuery(api.earnings.summary);
  const cashOut = useMutation(api.earnings.cashOutInstant);
  const [msg, setMsg] = useState("");
  const [error, setError] = useState("");
  if (!s) return <Body muted>Loading…</Body>;
  const max = Math.max(1, ...s.week.map((d) => d.cents));

  return (
    <View style={{ gap: 18 }}>
      <View style={{ gap: 4 }}>
        <Eyebrow>Available to cash out</Eyebrow>
        <Big>{money2(s.balanceCents)}</Big>
        {s.pendingCrewCents > 0 && <Body muted small>Plus {money2(s.pendingCrewCents)} of your tips in today's crew pool. Your share lands when the crew closes.</Body>}
      </View>
      {msg ? <Row><Body>{msg}</Body><DemoTag /></Row> : null}
      <ErrorText>{error}</ErrorText>
      <Btn kind="primary" title="Cash out now · arrives in minutes" disabled={s.balanceCents <= s.instantFeeCents}
        onPress={async () => {
          setError(""); setMsg("");
          try { const r = await cashOut({}); setMsg(`${money2(r.sentCents)} sent to your debit card`); } catch (e) { setError(errorText(e)); }
        }} />
      <Body muted small>Instant fee {money2(s.instantFeeCents)}. Free if you wait for the weekly payout.</Body>
      <Card>
        <Eyebrow>Last 7 days</Eyebrow>
        {s.week.map((d) => (
          <Row key={d.start}>
            <Body style={{ width: 44 }}>{new Date(d.start).toLocaleDateString([], { weekday: "short" })}</Body>
            <View style={{ flex: 1, height: 8, borderRadius: 4, backgroundColor: c.sunk }}>
              <View style={{ width: `${(d.cents / max) * 100}%`, height: 8, borderRadius: 4, backgroundColor: c.green }} />
            </View>
            <Body style={{ minWidth: 72, textAlign: "right" }}>{money2(d.cents)}</Body>
          </Row>
        ))}
      </Card>
    </View>
  );
}
