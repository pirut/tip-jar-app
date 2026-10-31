import { Linking, Pressable, StyleSheet, Text, TextInput, View, type TextInputProps, type ViewStyle } from "react-native";
import { TIP_ORIGIN } from "./format";
import { useColors } from "./theme";

export const FONT = {
  display: "BigShoulders_800ExtraBold",
  body: "InstrumentSans_400Regular",
  bodyBold: "InstrumentSans_600SemiBold",
  mono: "DMMono_400Regular",
};

export function Btn({ title, onPress, kind = "plain", disabled, style }: {
  title: string; onPress: () => void; kind?: "plain" | "primary" | "dark" | "ghost"; disabled?: boolean; style?: ViewStyle;
}) {
  const c = useColors();
  const bg = kind === "primary" ? c.green : kind === "dark" ? c.ink : kind === "ghost" ? "transparent" : c.sunk;
  const fg = kind === "primary" ? c.greenInk : kind === "dark" ? c.surface : kind === "ghost" ? c.muted : c.ink;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: !!disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [s.btn, { backgroundColor: bg, opacity: disabled ? 0.45 : pressed ? 0.85 : 1, transform: [{ scale: pressed ? 0.98 : 1 }] }, style]}
    >
      <Text style={[s.btnText, { color: fg }]}>{title}</Text>
    </Pressable>
  );
}

export function Field(props: TextInputProps & { label: string }) {
  const c = useColors();
  return (
    <View style={{ gap: 6 }}>
      <Text style={{ fontSize: 13, fontFamily: FONT.bodyBold, color: c.ink }}>{props.label}</Text>
      <TextInput
        placeholderTextColor={c.muted}
        accessibilityLabel={props.label}
        {...props}
        style={[s.input, { borderColor: c.control, backgroundColor: c.surface, color: c.ink }, props.style]}
      />
    </View>
  );
}

export function Eyebrow({ children, color }: { children: React.ReactNode; color?: string }) {
  const c = useColors();
  return <Text style={{ fontSize: 11, letterSpacing: 1.2, textTransform: "uppercase", color: color ?? c.muted, fontFamily: FONT.mono }}>{children}</Text>;
}

export function Big({ children, size = 64, color }: { children: React.ReactNode; size?: number; color?: string }) {
  const c = useColors();
  return <Text style={{ fontSize: size, lineHeight: size * 1.05, fontFamily: FONT.display, color: color ?? c.ink, fontVariant: ["tabular-nums"] }}>{children}</Text>;
}

export function Title({ children }: { children: React.ReactNode }) {
  const c = useColors();
  return <Text accessibilityRole="header" style={{ fontSize: 28, lineHeight: 31, fontFamily: FONT.display, color: c.ink, textTransform: "uppercase" }}>{children}</Text>;
}

export function Body({ children, muted, small, style }: { children: React.ReactNode; muted?: boolean; small?: boolean; style?: object }) {
  const c = useColors();
  return <Text style={[{ color: muted ? c.muted : c.ink, fontFamily: FONT.body, fontSize: small ? 13 : 16, lineHeight: small ? 18 : 22 }, style]}>{children}</Text>;
}

export function ErrorText({ children }: { children: React.ReactNode }) {
  const c = useColors();
  return children ? <Text accessibilityRole="alert" accessibilityLiveRegion="assertive" style={{ color: c.warn, fontFamily: FONT.bodyBold }}>{children}</Text> : null;
}

export function Card({ children, style }: { children: React.ReactNode; style?: ViewStyle }) {
  const c = useColors();
  return <View style={[{ backgroundColor: c.surface, borderColor: c.line, borderWidth: 1, borderRadius: 18, padding: 16, gap: 10 }, style]}>{children}</View>;
}

export function Row({ children, style }: { children: React.ReactNode; style?: ViewStyle }) {
  return <View style={[{ flexDirection: "row", alignItems: "center", gap: 10 }, style]}>{children}</View>;
}

export function Avatar({ name, size = 34 }: { name: string; size?: number }) {
  const c = useColors();
  const letters = name.split(/\s+/).filter(Boolean).map((w) => w[0]).join("").slice(0, 2).toUpperCase();
  return (
    <View accessibilityElementsHidden importantForAccessibility="no" style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: c.green, alignItems: "center", justifyContent: "center" }}>
      <Text style={{ color: c.greenInk, fontFamily: FONT.display, fontSize: size * 0.44 }}>{letters}</Text>
    </View>
  );
}

export function Seg<T extends string>({ options, value, onChange, disabled }: {
  options: [T, string][]; value: T; onChange: (v: T) => void; disabled?: boolean;
}) {
  const c = useColors();
  return (
    <View accessibilityRole="radiogroup" style={{ flexDirection: "row", backgroundColor: c.sunk, borderRadius: 12, padding: 3, gap: 3 }}>
      {options.map(([k, label]) => (
        <Pressable key={k} disabled={disabled} onPress={() => onChange(k)} accessibilityRole="radio" accessibilityState={{ selected: value === k, disabled: !!disabled }}
          style={{ flex: 1, minHeight: 44, justifyContent: "center", borderRadius: 9, alignItems: "center", backgroundColor: value === k ? c.segOn : "transparent" }}>
          <Text style={{ fontSize: 13, fontFamily: FONT.bodyBold, color: value === k ? c.ink : c.muted }}>{label}</Text>
        </Pressable>
      ))}
    </View>
  );
}

export function DemoTag() {
  const c = useColors();
  return (
    <View style={{ backgroundColor: c.warn, borderRadius: 5, paddingHorizontal: 6, paddingVertical: 1 }}>
      <Text style={{ fontSize: 11, color: c.bg, fontFamily: FONT.mono, letterSpacing: 0.6 }}>DEMO</Text>
    </View>
  );
}

// Payments are simulated until Stripe is connected, and every money screen has to say so.
export function DemoBar() {
  const c = useColors();
  return (
    <View accessibilityRole="text" style={{ backgroundColor: c.warn, paddingVertical: 6, paddingHorizontal: 12 }}>
      <Text style={{ color: c.bg, textAlign: "center", fontSize: 13, fontFamily: FONT.body }}><Text style={{ fontFamily: FONT.bodyBold }}>Demo mode </Text>No real money moves.</Text>
    </View>
  );
}

export function Banner({ children, style }: { children: React.ReactNode; style?: ViewStyle }) {
  const c = useColors();
  return <View accessibilityLiveRegion="polite" style={[{ backgroundColor: c.brassSoft, borderRadius: 14, padding: 12, gap: 8 }, style]}>{children}</View>;
}

export function LegalLinks() {
  return (
    <Row style={{ justifyContent: "center" }}>
      <Btn kind="ghost" title="Privacy" onPress={() => Linking.openURL(`${TIP_ORIGIN}/privacy`)} />
      <Btn kind="ghost" title="Terms" onPress={() => Linking.openURL(`${TIP_ORIGIN}/terms`)} />
    </Row>
  );
}

const s = StyleSheet.create({
  btn: { borderRadius: 16, minHeight: 50, paddingVertical: 13, paddingHorizontal: 16, alignItems: "center", justifyContent: "center" },
  btnText: { fontSize: 16, fontFamily: FONT.bodyBold },
  input: { borderWidth: 1, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12, minHeight: 48, fontSize: 16, fontFamily: FONT.body },
});
