import { Pressable, StyleSheet, Text, TextInput, View, type TextInputProps, type ViewStyle } from "react-native";
import { useColors } from "./theme";

export function Btn({ title, onPress, kind = "plain", disabled, style }: {
  title: string; onPress: () => void; kind?: "plain" | "primary" | "dark" | "ghost"; disabled?: boolean; style?: ViewStyle;
}) {
  const c = useColors();
  const bg = kind === "primary" ? c.green : kind === "dark" ? c.ink : kind === "ghost" ? "transparent" : c.sunk;
  const fg = kind === "primary" ? c.greenInk : kind === "dark" ? c.surface : kind === "ghost" ? c.muted : c.ink;
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [s.btn, { backgroundColor: bg, opacity: disabled ? 0.45 : pressed ? 0.85 : 1 }, style]}
    >
      <Text style={[s.btnText, { color: fg }]}>{title}</Text>
    </Pressable>
  );
}

export function Field(props: TextInputProps & { label: string }) {
  const c = useColors();
  return (
    <View style={{ gap: 6 }}>
      <Text style={{ fontSize: 13, fontWeight: "600", color: c.ink }}>{props.label}</Text>
      <TextInput
        placeholderTextColor={c.muted}
        {...props}
        style={[s.input, { borderColor: c.line, backgroundColor: c.surface, color: c.ink }, props.style]}
      />
    </View>
  );
}

export function Eyebrow({ children }: { children: React.ReactNode }) {
  const c = useColors();
  return <Text style={{ fontSize: 11, letterSpacing: 1.2, textTransform: "uppercase", color: c.muted, fontWeight: "600" }}>{children}</Text>;
}

export function Big({ children, size = 64 }: { children: React.ReactNode; size?: number }) {
  const c = useColors();
  return <Text style={{ fontSize: size, fontWeight: "900", color: c.ink, fontVariant: ["tabular-nums"], letterSpacing: -1 }}>{children}</Text>;
}

export function Title({ children }: { children: React.ReactNode }) {
  const c = useColors();
  return <Text style={{ fontSize: 26, fontWeight: "900", color: c.ink, textTransform: "uppercase" }}>{children}</Text>;
}

export function Body({ children, muted, small, style }: { children: React.ReactNode; muted?: boolean; small?: boolean; style?: object }) {
  const c = useColors();
  return <Text style={[{ color: muted ? c.muted : c.ink, fontSize: small ? 13 : 16, lineHeight: small ? 18 : 22 }, style]}>{children}</Text>;
}

export function ErrorText({ children }: { children: React.ReactNode }) {
  const c = useColors();
  return children ? <Text style={{ color: c.warn, fontWeight: "600" }}>{children}</Text> : null;
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
    <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: c.green, alignItems: "center", justifyContent: "center" }}>
      <Text style={{ color: c.greenInk, fontWeight: "900", fontSize: size * 0.42 }}>{letters}</Text>
    </View>
  );
}

export function Seg<T extends string>({ options, value, onChange, disabled }: {
  options: [T, string][]; value: T; onChange: (v: T) => void; disabled?: boolean;
}) {
  const c = useColors();
  return (
    <View style={{ flexDirection: "row", backgroundColor: c.sunk, borderRadius: 12, padding: 3, gap: 3 }}>
      {options.map(([k, label]) => (
        <Pressable key={k} disabled={disabled} onPress={() => onChange(k)}
          style={{ flex: 1, paddingVertical: 9, borderRadius: 9, alignItems: "center", backgroundColor: value === k ? c.surface : "transparent" }}>
          <Text style={{ fontSize: 13, fontWeight: "600", color: value === k ? c.ink : c.muted }}>{label}</Text>
        </Pressable>
      ))}
    </View>
  );
}

export function DemoTag() {
  const c = useColors();
  return <Text style={{ fontSize: 10, color: c.warn, borderColor: c.warn, borderWidth: 1, borderRadius: 5, paddingHorizontal: 4, overflow: "hidden" }}>DEMO</Text>;
}

const s = StyleSheet.create({
  btn: { borderRadius: 16, paddingVertical: 15, paddingHorizontal: 16, alignItems: "center", justifyContent: "center" },
  btnText: { fontSize: 16, fontWeight: "600" },
  input: { borderWidth: 1, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12, fontSize: 16 },
});
