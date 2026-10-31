export const money = (cents: number) => {
  const s = (cents / 100).toFixed(2);
  return "$" + (s.endsWith(".00") ? s.slice(0, -3) : s);
};
export const money2 = (cents: number) => "$" + (cents / 100).toFixed(2);
export const time = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
export const initials = (name: string) =>
  name.split(/\s+/).filter(Boolean).map((w) => w[0]).join("").slice(0, 2).toUpperCase() || "?";

// Keypad entry as a dollar string, e.g. "12.5"
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
  if (typeof data === "string") return data;
  return "Something went wrong. Try again.";
}

// Where to land after signing in. Built from known params only, so a crafted URL can't redirect off-site.
export function returnPath(search: string): string {
  const params = new URLSearchParams(search);
  const join = params.get("join");
  if (join && /^\d{4}$/.test(join)) return `/app?join=${join}`;
  const tab = params.get("tab");
  return tab === "crew" || tab === "earn" ? `/app?tab=${tab}` : "/app";
}
