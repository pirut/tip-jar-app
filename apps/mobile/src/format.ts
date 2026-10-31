export const money = (cents: number) => {
  const s = money2(cents);
  return s.endsWith(".00") ? s.slice(0, -3) : s;
};
export const money2 = (cents: number) => {
  const [whole, part] = (cents / 100).toFixed(2).split(".");
  return `$${whole.replace(/\B(?=(\d{3})+$)/g, ",")}.${part}`;
};
export const time = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
export const dateTime = (ms: number) => `${new Date(ms).toLocaleDateString([], { month: "short", day: "numeric" })}, ${time(ms)}`;
export const initials = (name: string) =>
  name.split(/\s+/).filter(Boolean).map((w) => w[0]).join("").slice(0, 2).toUpperCase() || "?";
export function typeKey(entry: string, key: string): string {
  if (key === "del") return entry.slice(0, -1);
  if (key === ".") return entry.includes(".") ? entry : (entry || "0") + ".";
  if (/\.\d\d$/.test(entry) || entry.replace(".", "").length >= 5) return entry;
  return entry === "0" ? key : entry + key;
}
export const entryCents = (entry: string) => {
  const n = parseFloat(entry);
  return Number.isNaN(n) ? 0 : Math.round(n * 100);
};
export function errorText(e: unknown): string {
  const data = (e as { data?: unknown })?.data;
  return typeof data === "string" ? data : "Something went wrong. Try again.";
}
// Each build must share its worker and crew records with the website it links to.
export const TIP_ORIGIN = (process.env.EXPO_PUBLIC_TIP_ORIGIN || "https://tip.jrbussard.com").replace(/\/+$/, "");
