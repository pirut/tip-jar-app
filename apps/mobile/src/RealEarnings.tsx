import { useEffect, useRef, useState } from "react";
import { Text, View } from "react-native";
import * as WebBrowser from "expo-web-browser";
import { useAction, useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { dateTime, errorText, money2 } from "./format";
import { useColors } from "./theme";
import { useDayStart } from "./useDayStart";
import { Banner, Big, Body, Btn, Card, ErrorText, Eyebrow, FONT, Loading, Row, TestTag } from "./ui";

const dayName = (start: number, format: "narrow" | "long") => new Date(start + 12 * 3600000).toLocaleDateString([], { weekday: format });

const PAYOUT_STATUS: Record<string, string> = { paid: "Paid", pending: "On the way", in_transit: "On the way", failed: "Failed", canceled: "Canceled" };

const SETUP_TEXT: Record<string, { title: string; body: string; action?: string }> = {
  setup: { title: "Set up payouts", body: "Tips reach your bank through Stripe, our payments partner. Stripe asks for your identity and bank details on its secure page. Tip Jar never sees them.", action: "Set up payouts" },
  action_needed: { title: "Finish setting up payouts", body: "Stripe needs a bit more from you before you can take tips.", action: "Continue setup" },
  pending: { title: "Stripe is checking your details", body: "This usually doesn't take long. You can't take tips until it's done.", action: "Check or update details" },
  frozen: { title: "Your payouts are on hold", body: "A refund or dispute needs attention, so money isn't moving to your account. Contact support." },
  suspended: { title: "Your account is paused", body: "You can't take tips right now. Contact support." },
  paused: { title: "Tips are paused", body: "We've paused tips for now. Money you've already earned is safe." },
};

// What a worker needs to do before they can take real tips. Stripe's form opens in a browser sheet,
// and coming back re-checks with Stripe.
export function PayoutSetupCard({ stage }: { stage: string }) {
  const start = useAction(api.paymentsNode.startPayoutSetup);
  const refresh = useAction(api.paymentsNode.refreshPayoutStatus);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const text = SETUP_TEXT[stage];
  if (!text) return null;

  async function open() {
    setBusy(true);
    setError("");
    try {
      const { url } = await start({});
      await WebBrowser.openBrowserAsync(url);
      await refresh({});
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Banner>
      <Text accessibilityRole="header" style={{ fontFamily: FONT.bodyBold, fontSize: 16 }}>{text.title}</Text>
      <Body small>{text.body}</Body>
      <ErrorText>{error}</ErrorText>
      {text.action && <Btn kind="primary" title={busy ? "Opening Stripe…" : text.action} disabled={busy} onPress={open} />}
    </Banner>
  );
}

export function RealEarnings() {
  const c = useColors();
  const dayStart = useDayStart();
  const r = useQuery(api.earnings.real, { dayStart });
  const refreshBalance = useAction(api.paymentsNode.refreshBalance);
  const refreshStatus = useAction(api.paymentsNode.refreshPayoutStatus);
  const dashboard = useAction(api.paymentsNode.payoutDashboardLink);
  const [error, setError] = useState("");
  const [opening, setOpening] = useState(false);
  const refreshed = useRef(false);

  useEffect(() => {
    if (refreshed.current) return;
    refreshed.current = true;
    // These are Stripe's figures, so ask Stripe. The last known ones still show if this fails.
    refreshStatus({}).then(() => refreshBalance({})).catch(() => {});
  }, [refreshBalance, refreshStatus]);

  async function openDashboard() {
    setOpening(true);
    setError("");
    try {
      const { url } = await dashboard({});
      await WebBrowser.openBrowserAsync(url);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setOpening(false);
    }
  }

  if (!r) return <Loading />;
  const max = Math.max(1, ...r.week.map((d) => d.cents));
  const weekCents = r.week.reduce((a, d) => a + d.cents, 0);
  const weekLabel = r.week.filter((d) => d.cents).map((d) => `${dayName(d.start, "long")} ${money2(d.cents)}`).join(", ");
  const line = (label: string, value: string) => (
    <Row style={{ justifyContent: "space-between" }}>
      <View style={{ flexShrink: 1 }}><Body small>{label}</Body></View>
      <Text style={{ color: c.ink, fontFamily: FONT.bodyBold, fontVariant: ["tabular-nums"] }}>{value}</Text>
    </Row>
  );

  // Nothing to show until there's a Stripe account, and a dash for a balance would only confuse.
  if (r.stage === "setup") return <PayoutSetupCard stage={r.stage} />;

  return (
    <View style={{ gap: 18 }}>
      <PayoutSetupCard stage={r.stage} />
      <View style={{ gap: 4 }}>
        <Row><Eyebrow>Available in Stripe</Eyebrow>{r.testMode && <TestTag />}</Row>
        <Big>{r.availableCents === null ? "—" : money2(r.availableCents)}</Big>
        <Body muted small>{r.payoutsPaused ? "Payouts are on hold." : "Pays out to your bank every Monday."}</Body>
      </View>
      <Card>
        {r.stripePendingCents !== null && line("On its way to available", money2(r.stripePendingCents))}
        {line(`On hold with Tip Jar${r.nextTransferAt && r.onHoldCents > 0 ? `, next release ${dateTime(r.nextTransferAt)}` : ""}`, money2(r.onHoldCents))}
        {r.crewPoolCents > 0 && line("Your tips in today's crew pool. Your share comes when it closes", money2(r.crewPoolCents))}
        {r.owedCents > 0 && line("Owed back from a refund or dispute. Comes out of later tips", `−${money2(r.owedCents)}`)}
        {r.balanceSyncedAt !== null && <Body muted small>Stripe figures from {dateTime(r.balanceSyncedAt)}.</Body>}
      </Card>
      <ErrorText>{error}</ErrorText>
      <Btn title={opening ? "Opening…" : "Bank and tax details"} disabled={opening} onPress={openDashboard} />
      <Card>
        <Row style={{ justifyContent: "space-between" }}><Eyebrow>Last 7 days</Eyebrow><View style={{ flexShrink: 1 }}><Big size={30}>{money2(weekCents)}</Big></View></Row>
        {weekCents === 0 ? <Body muted small>Your week fills in as tips arrive.</Body> : (
          <View accessible accessibilityRole="image" accessibilityLabel={`Earnings by day, ${money2(weekCents)} in total. ${weekLabel}`} style={{ flexDirection: "row", gap: 6 }}>
            {r.week.map((d, i) => (
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
      {r.payouts.length > 0 && (
        <Card>
          <Eyebrow>Payouts to your bank</Eyebrow>
          {r.payouts.map((p) => (
            <Row key={p.id} style={{ justifyContent: "space-between" }}>
              <View style={{ flexShrink: 1 }}>
                <Body>{PAYOUT_STATUS[p.status] ?? p.status}</Body>
                <Body muted small>{p.status === "failed" ? p.failureMessage ?? "Check your bank details." : `Arrives ${dateTime(p.arrivalDate)}`}</Body>
              </View>
              <Text style={{ color: c.ink, fontFamily: FONT.bodyBold, fontVariant: ["tabular-nums"] }}>{money2(p.amountCents)}</Text>
            </Row>
          ))}
        </Card>
      )}
    </View>
  );
}
