import { useColorScheme } from "react-native";

const light = {
  bg: "#eef1ec", surface: "#ffffff", sunk: "#e3e8e2", ink: "#14211b", muted: "#5b6b62", line: "#cfd8d1",
  green: "#0f4a36", greenInk: "#ffffff", brass: "#b88a12", brassSoft: "#f5e9c4", good: "#1d7a4c", warn: "#a35a00",
};
const dark: typeof light = {
  bg: "#0b1310", surface: "#13201b", sunk: "#1a2a23", ink: "#e6eee8", muted: "#9aaba1", line: "#2a3b33",
  green: "#3fae7f", greenInk: "#06140e", brass: "#e0b941", brassSoft: "#3a3115", good: "#4fc98a", warn: "#f0a24a",
};
export type Colors = typeof light;
export function useColors(): Colors {
  return useColorScheme() === "dark" ? dark : light;
}
