import { useColorScheme } from "react-native";

// Same tokens as the web design system: white surfaces, one forest green, amber only for demo labels.
const light = {
  bg: "#ffffff", surface: "#ffffff", sunk: "#f4f6f5", soft: "#e8f1ec", ink: "#101614", muted: "#59645f", line: "#e3e7e5",
  green: "#1c5a41", greenInk: "#ffffff", good: "#1c5a41", control: "#8a9490", segOn: "#ffffff",
  danger: "#b3261e", dangerInk: "#ffffff", demoBg: "#fdf4dc", demoInk: "#6b4700",
};
const dark: typeof light = {
  bg: "#0e1412", surface: "#161d1a", sunk: "#1b2420", soft: "#1b3027", ink: "#eef2f0", muted: "#a3aea9", line: "#252e2a",
  green: "#5cc79b", greenInk: "#07140e", good: "#6fd0a8", control: "#68746e", segOn: "#2a3a33",
  danger: "#f28b82", dangerInk: "#1f0b09", demoBg: "#2e2610", demoInk: "#edcd7d",
};
export type Colors = typeof light;
export function useColors(): Colors {
  return useColorScheme() === "dark" ? dark : light;
}
