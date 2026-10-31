import { useEffect, useRef, useState } from "react";
import { AccessibilityInfo, Animated, BackHandler, Pressable, Switch, Text, View, useWindowDimensions } from "react-native";
import { useMutation, useQuery } from "convex/react";
import QRCode from "react-native-qrcode-svg";
import Svg, { Path } from "react-native-svg";
import { api } from "../../../convex/_generated/api";
import { MAX_TIP_CENTS, MIN_TIP_CENTS, PRESETS_CENTS, feesCents } from "../../../convex/lib/money";
import { TIP_ORIGIN, dateTime, entryCents, errorText, money, money2, time, typeKey } from "./format";
import { useColors } from "./theme";
import { useDayStart } from "./useDayStart";
import { Big, Body, Btn, Card, DemoTag, ErrorText, Eyebrow, FONT, Row, Success, announce, shareText } from "./ui";

type Step = "home" | "amount" | "tap" | "qr";
const KEY_ROWS = [["1", "2", "3"], ["4", "5", "6"], ["7", "8", "9"], [".", "0", "del"]];

export function TipsScreen({ handle, name, inCrew, onFlowChange, onTipped }: { handle: string; name: string; inCrew: boolean; onFlowChange: (inFlow: boolean) => void; onTipped: () => void }) {
  const c = useColors();
  const dayStart = useDayStart();
  const today = useQuery(api.tips.today, { dayStart });
  const recordTap = useMutation(api.tips.recordTap);
  const { height } = useWindowDimensions();
  const compact = height < 700; // keeps the keypad and Charge button on one screen on small phones
  const [step, setStep] = useState<Step>("home");
  const [entry, setEntry] = useState("");
  const [cover, setCover] = useState(true);
  const [last, setLast] = useState<string>("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const cents = entryCents(entry);
  const valid = cents >= MIN_TIP_CENTS && cents <= MAX_TIP_CENTS;
  const fees = cents ? feesCents(cents) : 0;
  const charge = cents + (cover ? fees : 0);
  const net = cover ? cents : cents - fees;
  const link = `${TIP_ORIGIN}/${handle}`;

  const exit = () => { setError(""); setStep("home"); };

  useEffect(() => onFlowChange(step !== "home"), [step]);

  useEffect(() => {
    if (step === "home") return;
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      if (!busy) exit();
      return true;
    });
    return () => sub.remove();
  }, [step, busy]);

  // Tap to Pay: simulated until Stripe Terminal is wired in (needs a dev build and Apple's Tap to Pay entitlement).
  async function guestTapped() {
    if (busy) return;
    setError("");
    setBusy(true);
    try {
      await recordTap({ amountCents: cents, coverFees: cover });
      const message = `+${money2(net)} recorded${inCrew ? ", in your crew pool" : ""}`;
      setLast(message);
      announce(`Demo tip: ${message}`);
      setStep("home");
      setEntry("");
      onTipped();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  if (step === "qr")
    return (
      <View style={{ gap: 18, flex: 1, alignItems: "center", justifyContent: "center" }}>
        <Eyebrow>Your tip QR code</Eyebrow>
        <View accessible accessibilityRole="image" accessibilityLabel={`QR code for your tip link, ${link}`} style={{ backgroundColor: "#fff", padding: 16, borderRadius: 16 }}>
          <QRCode value={link} size={220} />
        </View>
        <Body style={{ textAlign: "center" }}>Guests scan it and tip in seconds, with no app.</Body>
        <Body small muted>{link.replace(/^https?:\/\//, "")}</Body>
        <Row><DemoTag /><Body muted small>The tip page is simulated. No card is charged.</Body></Row>
        <Btn kind="primary" title="Share my link" style={{ alignSelf: "stretch" }} onPress={() => shareText(`Tip ${name}: ${link}`)} />
        <Btn kind="ghost" title="Done" onPress={exit} />
      </View>
    );

  if (step === "amount")
    return (
      <View style={{ gap: compact ? 10 : 14, flex: 1 }}>
        <Row style={{ justifyContent: "space-between" }}>
          <Btn kind="ghost" title="Cancel" style={{ paddingHorizontal: 0, minHeight: 44, paddingVertical: 8 }} onPress={exit} />
          <Row style={{ gap: 6 }}><Eyebrow>Accept a tip</Eyebrow><DemoTag /></Row>
        </Row>
        <View style={{ alignItems: "center" }} accessibilityLiveRegion="polite"><Big size={compact ? 52 : 64}>{entry ? "$" + entry : "$0"}</Big></View>
        <Row style={{ justifyContent: "center" }}>
          {PRESETS_CENTS.map((p) => (
            <Pressable key={p} accessibilityRole="button" accessibilityState={{ selected: cents === p }} onPress={() => setEntry(String(p / 100))}
              style={({ pressed }) => ({ flex: 1, alignItems: "center", backgroundColor: cents === p ? c.green : c.brassSoft, borderRadius: 999, minHeight: 44, justifyContent: "center", opacity: pressed ? 0.7 : 1 })}>
              <Text maxFontSizeMultiplier={1.4} style={{ color: cents === p ? c.greenInk : c.ink, fontFamily: FONT.bodyBold, fontSize: 18 }}>{money(p)}</Text>
            </Pressable>
          ))}
        </Row>
        <View style={{ gap: 8 }}>
          {KEY_ROWS.map((row) => (
            <View key={row[0]} style={{ flexDirection: "row", gap: 8 }}>
              {row.map((k) => (
                <Pressable key={k} accessibilityRole="button" onPress={() => setEntry((e) => typeKey(e, k))} accessibilityLabel={k === "del" ? "Delete" : k === "." ? "Decimal point" : k}
                  style={({ pressed }) => ({ flex: 1, minHeight: compact ? 46 : 54, justifyContent: "center", backgroundColor: c.sunk, borderRadius: 14, alignItems: "center", opacity: pressed ? 0.7 : 1 })}>
                  {k === "del"
                    ? <Svg width={24} height={24} viewBox="0 0 24 24" fill="none" stroke={c.ink} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><Path d="M9 5h11a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H9l-6-7 6-7Zm3 4 5 6m0-6-5 6" /></Svg>
                    : <Text maxFontSizeMultiplier={1.4} style={{ fontSize: 22, fontFamily: FONT.bodyBold, color: c.ink }}>{k}</Text>}
                </Pressable>
              ))}
            </View>
          ))}
        </View>
        <Row style={{ justifyContent: "space-between" }}>
          <View style={{ flex: 1 }}>
            <Body small>Guest covers the {cents ? `${money2(fees)} in ` : ""}fees</Body>
            {valid && <Body muted small>Guest pays {money2(charge)} · you get {money2(net)}</Body>}
          </View>
          <Switch accessibilityLabel="Guest covers fees" value={cover} onValueChange={setCover} trackColor={{ true: c.green, false: c.control }} />
        </Row>
        {!!cents && !valid && <ErrorText>Tips can be {money(MIN_TIP_CENTS)} to {money(MAX_TIP_CENTS)}.</ErrorText>}
        <View style={{ marginTop: "auto" }}>
          <Btn kind="primary" title={valid ? `Charge ${money2(charge)} (demo)` : "Enter an amount"} disabled={!valid} onPress={() => setStep("tap")} />
        </View>
      </View>
    );

  if (step === "tap")
    return (
      <View style={{ flex: 1, gap: 18 }}>
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: 18 }}>
          <Eyebrow>Hand the phone to the guest</Eyebrow>
          <Big size={48}>{money2(charge)}</Big>
          <Pulse />
          <Body style={{ textAlign: "center" }}>Hold card or phone near the top of this phone</Body>
          <Row><DemoTag /><Body muted small>Tap to Pay is simulated. No card is charged.</Body></Row>
        </View>
        <ErrorText>{error}</ErrorText>
        <Btn kind="primary" title={busy ? "Recording…" : "Simulate guest tap"} disabled={busy} onPress={guestTapped} />
        <Btn kind="ghost" title="Cancel" disabled={busy} onPress={exit} />
      </View>
    );

  return (
    <View style={{ gap: 18 }}>
      <View style={{ gap: 4 }}>
        <Row><Eyebrow>Tips today</Eyebrow><DemoTag /></Row>
        <Big>{today ? money2(today.totalCents) : "—"}</Big>
        {today && today.crewCents > 0 && <Body muted small>{money2(today.crewCents)} went to your crew pool</Body>}
      </View>
      {last ? <Success demo>{last}</Success> : null}
      <Btn kind="primary" title="Accept a tip" onPress={() => { setLast(""); setEntry(""); setStep("amount"); }} style={{ paddingVertical: 28, borderRadius: 22 }} />
      <Btn title="Show my QR code" onPress={() => setStep("qr")} />
      <Card>
        <Eyebrow>Recent</Eyebrow>
        {today === undefined && <Body muted small>Loading…</Body>}
        {today?.recent.length === 0 && <Body muted small>No tips yet. Accept one above, or show guests your QR code.</Body>}
        {today?.recent.slice(0, 8).map((t) => (
          <Row key={t._id} style={{ justifyContent: "space-between" }}>
            <View style={{ flexShrink: 1 }}>
              <Body>{t.payerLabel}</Body>
              <Body muted small>{t.at >= dayStart ? time(t.at) : dateTime(t.at)} · {t.source === "qr" ? "QR code" : "Tap to Pay"}{t.toCrew ? " · to crew pool" : ""}{t.demo ? " · Demo" : ""}</Body>
            </View>
            <Text style={{ color: c.ink, fontFamily: FONT.bodyBold, fontVariant: ["tabular-nums"] }}>+{money2(t.netCents)}</Text>
          </Row>
        ))}
      </Card>
    </View>
  );
}

function Pulse() {
  const c = useColors();
  const v = useRef(new Animated.Value(0)).current;
  const [still, setStill] = useState(false);
  useEffect(() => {
    let live = true;
    AccessibilityInfo.isReduceMotionEnabled().then((reduced) => { if (live) setStill(reduced); });
    return () => { live = false; };
  }, []);
  useEffect(() => {
    if (still) return;
    const loop = Animated.loop(Animated.timing(v, { toValue: 1, duration: 1600, useNativeDriver: true }));
    loop.start();
    return () => loop.stop();
  }, [v, still]);
  return (
    <View accessibilityElementsHidden importantForAccessibility="no" style={{ width: 150, height: 150, alignItems: "center", justifyContent: "center" }}>
      {!still && <Animated.View style={{ position: "absolute", width: 150, height: 150, borderRadius: 75, borderWidth: 3, borderColor: c.green,
        opacity: v.interpolate({ inputRange: [0, 1], outputRange: [0.9, 0] }), transform: [{ scale: v.interpolate({ inputRange: [0, 1], outputRange: [0.4, 1] }) }] }} />}
      <Svg width={56} height={56} viewBox="0 0 24 24" fill="none" stroke={c.green} strokeWidth={2} strokeLinecap="round">
        <Path d="M6 9a5 5 0 0 1 0 6M10 6a10 10 0 0 1 0 12M14 3a15 15 0 0 1 0 18" />
      </Svg>
    </View>
  );
}
