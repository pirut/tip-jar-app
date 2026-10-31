import { useState } from "react";
import { Text, View } from "react-native";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { errorText, money2, time } from "./format";
import { useColors } from "./theme";
import { useDayStart } from "./useDayStart";
import { Banner, Big, Body, Btn, Card, DemoTag, ErrorText, Eyebrow, FONT, Row } from "./ui";

export function EarningsScreen() {
  const c = useColors();
  const dayStart = useDayStart();
  const s = useQuery(api.earnings.summary, { dayStart });
  const cashOut = useMutation(api.earnings.cashOutInstant);
  const [msg, setMsg] = useState("");
  const [error, setError] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  if (!s) return <Body muted>Loading…</Body>;
  const max = Math.max(1, ...s.week.map((d) => d.cents));
  const weekCents = s.week.reduce((a, d) => a + d.cents, 0);
  const canCashOut = s.balanceCents > s.instantFeeCents;

  async function instant() {
    if (busy) return;
    setError(""); setMsg(""); setBusy(true);
    try {
      const r = await cashOut({});
      setMsg(`${money2(r.sentCents)} would be sent to your debit card`);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  }

  return (
    <View style={{ gap: 18 }}>
      <View style={{ gap: 4 }}>
        <Row><Eyebrow>Available to cash out</Eyebrow><DemoTag /></Row>
        <Big>{money2(s.balanceCents)}</Big>
        {s.pendingCrewCents > 0 && <Body muted small>Plus {money2(s.pendingCrewCents)} of your tips in today's crew pool. Your share lands when the crew closes.</Body>}
      </View>
      {msg ? <Banner><Row style={{ flexWrap: "wrap" }}><Body>{msg}</Body><DemoTag /></Row></Banner> : null}
      <ErrorText>{error}</ErrorText>
      {confirming ? (
        <Banner>
          <Body>Cash out {money2(s.balanceCents)}? The instant fee is {money2(s.instantFeeCents)}, so you'd get {money2(s.balanceCents - s.instantFeeCents)}.</Body>
          <Btn kind="primary" title={busy ? "Working…" : "Cash out"} disabled={busy} onPress={instant} />
          <Btn kind="ghost" title="Cancel" onPress={() => setConfirming(false)} />
        </Banner>
      ) : (
        <View style={{ gap: 6 }}>
          <Btn kind="primary" title="Cash out now" disabled={!canCashOut} onPress={() => setConfirming(true)} />
          <Body muted small>{canCashOut ? `Instant fee ${money2(s.instantFeeCents)}.` : `You need more than the ${money2(s.instantFeeCents)} instant fee to cash out.`}</Body>
        </View>
      )}
      <Card>
        <Row style={{ justifyContent: "space-between" }}><Eyebrow>Last 7 days</Eyebrow><Big size={30}>{money2(weekCents)}</Big></Row>
        {weekCents === 0 ? <Body muted small>Your week fills in as tips arrive.</Body> : (
          <View accessible accessibilityLabel={`Earnings by day, ${money2(weekCents)} in total`} style={{ flexDirection: "row", gap: 6 }}>
            {s.week.map((d, i) => (
              <View key={d.start} style={{ flex: 1, alignItems: "center", gap: 4 }}>
                <Text numberOfLines={1} adjustsFontSizeToFit style={{ fontSize: 11, color: c.ink, fontFamily: FONT.bodyBold, minHeight: 15 }}>{d.cents ? money2(d.cents).replace(/\.00$/, "") : ""}</Text>
                <View style={{ height: 90, width: "100%", maxWidth: 30, justifyContent: "flex-end", backgroundColor: c.sunk, borderRadius: 6, overflow: "hidden" }}>
                  <View style={{ height: `${Math.max(d.cents ? 6 : 0, (d.cents / max) * 100)}%`, backgroundColor: i === 6 ? c.green : c.control, borderRadius: 6 }} />
                </View>
                <Body small muted={i !== 6}>{new Date(d.start + 12 * 3600000).toLocaleDateString([], { weekday: "narrow" })}</Body>
              </View>
            ))}
          </View>
        )}
      </Card>
      {s.cashouts.length > 0 && (
        <Card>
          <Eyebrow>Cash-outs</Eyebrow>
          {s.cashouts.map((o) => (
            <Row key={o.at} style={{ justifyContent: "space-between" }}>
              <View style={{ flexShrink: 1 }}>
                <Row style={{ gap: 6 }}><Body>Instant cash-out</Body>{o.demo && <DemoTag />}</Row>
                <Body muted small>{new Date(o.at).toLocaleDateString([], { month: "short", day: "numeric" })}, {time(o.at)} · {money2(o.feeCents)} fee</Body>
              </View>
              <Body>−{money2(o.amountCents)}</Body>
            </Row>
          ))}
        </Card>
      )}
    </View>
  );
}
