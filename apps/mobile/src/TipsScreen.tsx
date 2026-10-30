import { useEffect, useRef, useState } from "react";
import { Animated, Pressable, Text, View } from "react-native";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { PRESETS_CENTS, feesCents } from "../../../convex/lib/money";
import { entryCents, errorText, money, money2, time, typeKey } from "./format";
import { useColors } from "./theme";
import { Big, Body, Btn, Card, DemoTag, ErrorText, Eyebrow, Row } from "./ui";

type Step = "home" | "amount" | "tap";
const KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", ".", "0", "del"];

export function TipsScreen({ onTipped }: { onTipped: () => void }) {
  const c = useColors();
  const today = useQuery(api.tips.today);
  const recordTap = useMutation(api.tips.recordTap);
  const [step, setStep] = useState<Step>("home");
  const [entry, setEntry] = useState("");
  const [cover, setCover] = useState(true);
  const [last, setLast] = useState<string>("");
  const [error, setError] = useState("");
  const cents = entryCents(entry);

  // Tap to Pay: simulated until Stripe Terminal is wired in (needs a dev build and Apple's Tap to Pay entitlement).
  async function guestTapped() {
    setError("");
    try {
      await recordTap({ amountCents: cents, coverFees: cover });
      setLast(`+${money2(cents)} received`);
      setStep("home");
      setEntry("");
      onTipped();
    } catch (e) {
      setError(errorText(e));
    }
  }

  if (step === "amount")
    return (
      <View style={{ gap: 14, flex: 1 }}>
        <Row style={{ justifyContent: "space-between" }}>
          <Btn kind="ghost" title="Cancel" onPress={() => setStep("home")} />
          <Eyebrow>Accept a tip</Eyebrow>
          <View style={{ width: 60 }} />
        </Row>
        <View style={{ alignItems: "center" }}><Big>{entry ? "$" + entry : "$0"}</Big></View>
        <Row style={{ justifyContent: "center" }}>
          {PRESETS_CENTS.map((p) => (
            <Pressable key={p} onPress={() => setEntry(String(p / 100))} style={{ backgroundColor: c.brassSoft, borderRadius: 999, paddingVertical: 8, paddingHorizontal: 16 }}>
              <Text style={{ color: c.ink, fontWeight: "700" }}>{money(p)}</Text>
            </Pressable>
          ))}
        </Row>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          {KEYS.map((k) => (
            <Pressable key={k} onPress={() => setEntry((e) => typeKey(e, k))} accessibilityLabel={k === "del" ? "Delete" : k}
              style={{ width: "31.5%", backgroundColor: c.sunk, borderRadius: 14, paddingVertical: 14, alignItems: "center" }}>
              <Text style={{ fontSize: 22, fontWeight: "600", color: c.ink }}>{k === "del" ? "⌫" : k}</Text>
            </Pressable>
          ))}
        </View>
        <Pressable onPress={() => setCover(!cover)} style={{ backgroundColor: c.sunk, borderRadius: 14, padding: 12, flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
          <Text style={{ color: c.ink, flex: 1 }}>Guest covers the {cents ? money2(feesCents(cents)) : ""} in fees</Text>
          <Text style={{ color: cover ? c.good : c.muted, fontWeight: "700" }}>{cover ? "ON" : "OFF"}</Text>
        </Pressable>
        <View style={{ marginTop: "auto" }}>
          <Btn kind="primary" title={`Charge ${cents ? money2(cents + (cover ? feesCents(cents) : 0)) : ""}`} disabled={cents < 100} onPress={() => setStep("tap")} />
        </View>
      </View>
    );

  if (step === "tap")
    return (
      <View style={{ flex: 1, gap: 18 }}>
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: 18 }}>
          <Eyebrow>Hand the phone to the guest</Eyebrow>
          <Big size={44}>{money2(cents + (cover ? feesCents(cents) : 0))}</Big>
          <Pulse />
          <Body style={{ textAlign: "center" }}>Hold card or phone near the top of this phone</Body>
          <Row><DemoTag /><Body muted small>Tap to Pay is simulated for now.</Body></Row>
        </View>
        <ErrorText>{error}</ErrorText>
        <Btn kind="primary" title="Simulate guest tap" onPress={guestTapped} />
        <Btn kind="ghost" title="Cancel" onPress={() => setStep("home")} />
      </View>
    );

  return (
    <View style={{ gap: 18 }}>
      <View style={{ gap: 4 }}>
        <Eyebrow>Tips today</Eyebrow>
        <Big>{today ? money2(today.totalCents) : "—"}</Big>
      </View>
      {last ? (
        <View style={{ backgroundColor: c.brassSoft, borderRadius: 14, padding: 12, flexDirection: "row", justifyContent: "space-between" }}>
          <Text style={{ color: c.ink }}>{last}</Text><Text style={{ color: c.good, fontWeight: "700" }}>Received</Text>
        </View>
      ) : null}
      <Btn kind="primary" title="Accept a tip" onPress={() => { setLast(""); setEntry(""); setStep("amount"); }} style={{ paddingVertical: 28, borderRadius: 22 }} />
      <Card>
        <Eyebrow>Recent</Eyebrow>
        {today?.recent.length === 0 && <Body muted small>No tips yet today.</Body>}
        {today?.recent.slice(0, 8).map((t) => (
          <Row key={t._id} style={{ justifyContent: "space-between" }}>
            <View style={{ flexShrink: 1 }}>
              <Row style={{ gap: 6 }}><Body>{t.payerLabel}</Body>{t.demo && <DemoTag />}</Row>
              <Body muted small>{time(t.at)} · {t.source === "qr" ? "QR code" : "Tap to Pay"}{t.toCrew ? " · to crew pool" : ""}</Body>
            </View>
            <Text style={{ color: c.ink, fontWeight: "600", fontVariant: ["tabular-nums"] }}>+{money2(t.netCents)}</Text>
          </Row>
        ))}
      </Card>
    </View>
  );
}

function Pulse() {
  const c = useColors();
  const v = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(Animated.timing(v, { toValue: 1, duration: 1600, useNativeDriver: true }));
    loop.start();
    return () => loop.stop();
  }, [v]);
  return (
    <View style={{ width: 150, height: 150, alignItems: "center", justifyContent: "center" }}>
      <Animated.View style={{ position: "absolute", width: 150, height: 150, borderRadius: 75, borderWidth: 3, borderColor: c.green,
        opacity: v.interpolate({ inputRange: [0, 1], outputRange: [0.9, 0] }), transform: [{ scale: v.interpolate({ inputRange: [0, 1], outputRange: [0.4, 1] }) }] }} />
      <Text style={{ fontSize: 40, color: c.green }}>)))</Text>
    </View>
  );
}
