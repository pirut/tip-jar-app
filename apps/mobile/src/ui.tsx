import { Children, Component, useEffect, useState, type ErrorInfo, type ReactNode } from "react";
import { AccessibilityInfo, ActivityIndicator, Linking, Platform, Pressable, Share, StyleSheet, Text, TextInput, View, type TextInputProps, type ViewStyle } from "react-native";
import { useConvexConnectionState } from "convex/react";
import { SafeAreaView } from "react-native-safe-area-context";
import Svg, { Path } from "react-native-svg";
import { TIP_ORIGIN, initials } from "./format";
import { useColors } from "./theme";

export const FONT = {
  body: "InstrumentSans_400Regular",
  bodyBold: "InstrumentSans_600SemiBold",
};

// iOS has no live regions, so anything that appears on its own has to be spoken.
export function announce(text: string) {
  if (Platform.OS === "ios" && text) AccessibilityInfo.announceForAccessibility(text);
}

// The share sheet rejects on some Android targets; that's never worth a crash.
export function shareText(message: string) {
  Share.share({ message }).catch(() => {});
}

export function Btn({ title, onPress, kind = "plain", disabled, style, role = "button", label, hint }: {
  title: string; onPress: () => void; kind?: "plain" | "primary" | "dark" | "ghost" | "danger"; disabled?: boolean; style?: ViewStyle; role?: "button" | "link"; label?: string; hint?: string;
}) {
  const c = useColors();
  const bg = kind === "primary" ? c.green : kind === "dark" ? c.ink : kind === "danger" ? c.danger : kind === "ghost" ? "transparent" : c.sunk;
  const fg = kind === "primary" ? c.greenInk : kind === "dark" ? c.surface : kind === "danger" ? c.dangerInk : kind === "ghost" ? c.muted : c.ink;
  return (
    <Pressable
      accessibilityRole={role}
      accessibilityLabel={label}
      accessibilityHint={hint}
      accessibilityState={{ disabled: !!disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [s.btn, { backgroundColor: bg, opacity: disabled ? 0.45 : pressed ? 0.85 : 1, transform: [{ scale: pressed ? 0.98 : 1 }] }, style]}
    >
      <Text style={[s.btnText, { color: fg }]}>{title}</Text>
    </Pressable>
  );
}

// Border width stays fixed so focusing a field doesn't nudge the layout.
export function Input(props: TextInputProps) {
  const c = useColors();
  const [focused, setFocused] = useState(false);
  return (
    <TextInput
      placeholderTextColor={c.muted}
      {...props}
      onFocus={(e) => { setFocused(true); props.onFocus?.(e); }}
      onBlur={(e) => { setFocused(false); props.onBlur?.(e); }}
      style={[s.input, { borderColor: focused ? c.green : c.control, backgroundColor: c.surface, color: c.ink }, props.style]}
    />
  );
}

export function Field({ label, ...props }: TextInputProps & { label: string }) {
  const c = useColors();
  return (
    <View style={{ gap: 6 }}>
      <Text style={{ fontSize: 13, fontFamily: FONT.bodyBold, color: c.ink }}>{label}</Text>
      <Input accessibilityLabel={label} {...props} />
    </View>
  );
}

export function CheckIcon({ color }: { color: string }) {
  return <Svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round"><Path d="m5 13 4 4L19 7" /></Svg>;
}

// A completed action: the icon means it isn't carried by color alone.
export function Success({ children, demo }: { children: ReactNode; demo?: boolean }) {
  const c = useColors();
  return (
    <Banner>
      <Row><CheckIcon color={c.good} /><Body style={{ flex: 1 }}>{children}</Body>{demo && <DemoTag />}</Row>
    </Banner>
  );
}

export function Eyebrow({ children, color }: { children: ReactNode; color?: string }) {
  const c = useColors();
  return <Text maxFontSizeMultiplier={1.6} style={{ flexShrink: 1, fontSize: 13, color: color ?? c.muted, fontFamily: FONT.bodyBold }}>{children}</Text>;
}

// Money stays on one line: it shrinks to fit rather than wrapping mid-amount.
export function Big({ children, size = 48, color }: { children: ReactNode; size?: number; color?: string }) {
  const c = useColors();
  return <Text numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.5} maxFontSizeMultiplier={1.4} style={{ fontSize: size, lineHeight: size * 1.15, letterSpacing: size * -0.02, fontFamily: FONT.bodyBold, color: color ?? c.ink, fontVariant: ["tabular-nums"] }}>{children}</Text>;
}

export function Title({ children }: { children: ReactNode }) {
  const c = useColors();
  return <Text accessibilityRole="header" maxFontSizeMultiplier={1.5} style={{ fontSize: 24, lineHeight: 29, letterSpacing: -0.4, fontFamily: FONT.bodyBold, color: c.ink }}>{children}</Text>;
}

export function Body({ children, muted, small, style }: { children: ReactNode; muted?: boolean; small?: boolean; style?: object }) {
  const c = useColors();
  return <Text style={[{ flexShrink: 1, color: muted ? c.muted : c.ink, fontFamily: FONT.body, fontSize: small ? 13 : 16, lineHeight: small ? 18 : 22 }, style]}>{children}</Text>;
}

export function ErrorText({ children }: { children: ReactNode }) {
  const c = useColors();
  const text = Children.toArray(children).join("");
  useEffect(() => announce(text), [text]);
  return text ? <Text accessibilityRole="alert" accessibilityLiveRegion="assertive" style={{ color: c.danger, fontFamily: FONT.bodyBold }}>{text}</Text> : null;
}

export function Loading({ label = "Loading…" }: { label?: string }) {
  const c = useColors();
  return (
    <View accessible accessibilityLabel={label} style={{ flex: 1, minHeight: 160, alignItems: "center", justifyContent: "center", gap: 10 }}>
      <ActivityIndicator color={c.green} />
      <Body muted small>{label}</Body>
    </View>
  );
}

export function Card({ children, style }: { children: ReactNode; style?: ViewStyle }) {
  const c = useColors();
  return <View style={[{ backgroundColor: c.surface, borderColor: c.line, borderWidth: 1, borderRadius: 14, padding: 16, gap: 10 }, style]}>{children}</View>;
}

export function Row({ children, style }: { children: ReactNode; style?: ViewStyle }) {
  return <View style={[{ flexDirection: "row", alignItems: "center", gap: 10 }, style]}>{children}</View>;
}

export function Avatar({ name, size = 34 }: { name: string; size?: number }) {
  const c = useColors();
  return (
    <View accessibilityElementsHidden importantForAccessibility="no" style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: c.soft, alignItems: "center", justifyContent: "center" }}>
      <Text allowFontScaling={false} style={{ color: c.green, fontFamily: FONT.bodyBold, fontSize: size * 0.38 }}>{initials(name)}</Text>
    </View>
  );
}

export function Seg<T extends string>({ options, value, onChange, disabled, label }: {
  options: [T, string][]; value: T; onChange: (v: T) => void; disabled?: boolean; label: string;
}) {
  const c = useColors();
  return (
    <View accessibilityRole="radiogroup" accessibilityLabel={label} style={{ flexDirection: "row", backgroundColor: c.sunk, borderRadius: 12, padding: 3, gap: 3 }}>
      {options.map(([k, optionLabel]) => (
        <Pressable key={k} disabled={disabled} onPress={() => onChange(k)} accessibilityRole="radio" accessibilityState={{ checked: value === k, disabled: !!disabled }}
          style={({ pressed }) => ({ flex: 1, minHeight: 44, justifyContent: "center", borderRadius: 9, alignItems: "center", paddingHorizontal: 2, opacity: pressed ? 0.7 : 1, backgroundColor: value === k ? c.segOn : "transparent" })}>
          <Text numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.8} maxFontSizeMultiplier={1.4} style={{ fontSize: 13, textAlign: "center", fontFamily: FONT.bodyBold, color: value === k ? c.ink : c.muted }}>{optionLabel}</Text>
        </Pressable>
      ))}
    </View>
  );
}

export function DemoTag() {
  const c = useColors();
  return (
    <View style={{ backgroundColor: c.demoBg, borderRadius: 5, paddingHorizontal: 6, paddingVertical: 1 }}>
      <Text maxFontSizeMultiplier={1.4} style={{ fontSize: 12, color: c.demoInk, fontFamily: FONT.bodyBold }}>Demo</Text>
    </View>
  );
}

// Payments are simulated until Stripe is connected, and every money screen has to say so.
export function DemoBar() {
  const c = useColors();
  return (
    <View accessibilityRole="text" style={{ backgroundColor: c.demoBg, paddingVertical: 6, paddingHorizontal: 12 }}>
      <Text maxFontSizeMultiplier={1.5} style={{ color: c.demoInk, textAlign: "center", fontSize: 13, fontFamily: FONT.body }}><Text style={{ fontFamily: FONT.bodyBold }}>Demo mode. </Text>No real money moves.</Text>
    </View>
  );
}

// Convex holds queries and mutations until it reconnects, so without this a dropped
// connection looks like a screen that never loads. The delay hides routine blips.
export function ConnectionBar() {
  const c = useColors();
  const { isWebSocketConnected } = useConvexConnectionState();
  const [show, setShow] = useState(false);
  useEffect(() => {
    if (isWebSocketConnected) { setShow(false); return; }
    const id = setTimeout(() => { setShow(true); announce("No connection. Reconnecting."); }, 4000);
    return () => clearTimeout(id);
  }, [isWebSocketConnected]);
  if (!show) return null;
  return (
    <View accessibilityLiveRegion="polite" style={{ backgroundColor: c.sunk, paddingVertical: 6, paddingHorizontal: 12 }}>
      <Text maxFontSizeMultiplier={1.5} style={{ color: c.ink, textAlign: "center", fontSize: 13, fontFamily: FONT.bodyBold }}>No connection. Reconnecting…</Text>
    </View>
  );
}

export function Banner({ children, style }: { children: ReactNode; style?: ViewStyle }) {
  const c = useColors();
  return <View accessibilityLiveRegion="polite" style={[{ backgroundColor: c.soft, borderRadius: 12, padding: 12, gap: 8 }, style]}>{children}</View>;
}

function CrashScreen({ onRetry }: { onRetry: () => void }) {
  const c = useColors();
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: c.bg, padding: 18, gap: 14, justifyContent: "center" }}>
      <Title>Something went wrong</Title>
      <Body muted>Tip Jar hit a problem loading this screen. Your tips and balance aren't affected.</Body>
      <Btn kind="primary" title="Try again" onPress={onRetry} />
    </SafeAreaView>
  );
}

// A failed Convex query throws during render; without this it takes the whole app down.
export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(error, info.componentStack);
  }
  render() {
    return this.state.failed ? <CrashScreen onRetry={() => this.setState({ failed: false })} /> : this.props.children;
  }
}

export function LegalLinks() {
  const open = (path: string) => Linking.openURL(`${TIP_ORIGIN}${path}`).catch(() => {});
  return (
    <Row style={{ justifyContent: "center" }}>
      <Btn kind="ghost" role="link" title="Privacy" onPress={() => open("/privacy")} />
      <Btn kind="ghost" role="link" title="Terms" onPress={() => open("/terms")} />
    </Row>
  );
}

const s = StyleSheet.create({
  btn: { borderRadius: 12, minHeight: 50, paddingVertical: 13, paddingHorizontal: 16, alignItems: "center", justifyContent: "center" },
  btnText: { fontSize: 16, textAlign: "center", fontFamily: FONT.bodyBold },
  input: { borderWidth: 1.5, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12, minHeight: 48, fontSize: 16, fontFamily: FONT.body },
});
