import { useState } from "react";
import { Text, View } from "react-native";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { dateTime, errorText, money2 } from "./format";
import { RealEarnings } from "./RealEarnings";
import { useColors } from "./theme";
import { useDayStart } from "./useDayStart";
import { Banner, Big, Body, Btn, Card, DemoTag, ErrorText, Eyebrow, FONT, Loading, Row, Success, announce } from "./ui";

const dayName = (start: number, format: "narrow" | "long") => new Date(start + 12 * 3600000).toLocaleDateString([], { weekday: format });

export function EarningsScreen() {
  const status = useQuery(api.payments.status);
  if (status === undefined) return <Loading />;
  return status && status.stage !== "demo" ? <RealEarnings /> : <DemoEarnings />;
}

function DemoEarnings() {
  const c = useColors();
  const dayStart = useDayStart();
  const s = useQuery(api.earnings.summary, { dayStart });
  const cashOut = useMutation(api.earnings.cashOutInstant);
  const [msg, setMsg] = useState("");
  const [error, setError] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  if (!s) return <Loading />;
  const max = Math.max(1, ...s.week.map((d) => d.cents));
  const weekCents = s.week.reduce((a, d) => a + d.cents, 0);
  const canCashOut = s.balanceCents > s.instantFeeCents;
  const weekLabel = s.week.filter((d) => d.cents).map((d) => `${dayName(d.start, "long")} ${money2(d.cents)}`).join(", ");

  async function instant() {
    if (busy) return;
    setError(""); setMsg(""); setBusy(true);
    try {
      const r = await cashOut({});
      const text = `${money2(r.sentCents)} would be sent to your debit card`;
      setMsg(text);
      announce(`Demo: ${text}`);
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
      {msg ? <Success demo>{msg}</Success> : null}
      <ErrorText>{error}</ErrorText>
      {confirming ? (
        <Banner>
          <Body>Cash out {money2(s.balanceCents)}? The instant fee is {money2(s.instantFeeCents)}, so you'd get {money2(s.balanceCents - s.instantFeeCents)}. This is a demo, so no money moves.</Body>
          <Btn kind="primary" title={busy ? "Working…" : "Cash out (demo)"} disabled={busy} onPress={instant} />
          <Btn kind="ghost" title="Cancel" disabled={busy} onPress={() => setConfirming(false)} />
        </Banner>
      ) : (
        <View style={{ gap: 6 }}>
          <Btn kind="primary" title="Cash out now" disabled={!canCashOut} onPress={() => { setMsg(""); setError(""); setConfirming(true); }} />
          <Body muted small>{canCashOut ? `Instant fee ${money2(s.instantFeeCents)}.` : s.balanceCents === 0 ? "Tips you receive land here." : `You need more than the ${money2(s.instantFeeCents)} instant fee to cash out.`}</Body>
        </View>
      )}
      <Card>
        <Row style={{ justifyContent: "space-between" }}><Eyebrow>Last 7 days</Eyebrow><View style={{ flexShrink: 1 }}><Big size={30}>{money2(weekCents)}</Big></View></Row>
        {weekCents === 0 ? <Body muted small>Your week fills in as tips arrive.</Body> : (
          <View accessible accessibilityRole="image" accessibilityLabel={`Earnings by day, ${money2(weekCents)} in total. ${weekLabel}`} style={{ flexDirection: "row", gap: 6 }}>
            {s.week.map((d, i) => (
              <View key={d.start} style={{ flex: 1, alignItems: "center", gap: 4 }}>
                <Text numberOfLines={1} adjustsFontSizeToFit maxFontSizeMultiplier={1.2} style={{ fontSize: 11, color: c.ink, fontFamily: FONT.bodyBold, minHeight: 15 }}>{d.cents ? money2(d.cents).replace(/\.00$/, "") : ""}</Text>
                <View style={{ height: 90, width: "100%", maxWidth: 30, justifyContent: "flex-end", backgroundColor: c.sunk, borderRadius: 6, overflow: "hidden" }}>
                  <View style={{ height: `${Math.max(d.cents ? 6 : 0, (d.cents / max) * 100)}%`, backgroundColor: i === 6 ? c.green : c.control, borderRadius: 6 }} />
                </View>
                <Body small muted={i !== 6}>{dayName(d.start, "narrow")}</Body>
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
                <Body>Instant cash-out</Body>
                <Body muted small>{dateTime(o.at)} · {money2(o.feeCents)} fee{o.demo ? " · Demo" : ""}</Body>
              </View>
              <Text style={{ color: c.ink, fontFamily: FONT.bodyBold, fontVariant: ["tabular-nums"] }}>−{money2(o.amountCents)}</Text>
            </Row>
          ))}
        </Card>
      )}
    </View>
  );
}
