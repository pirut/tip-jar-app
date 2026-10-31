// Link names for the public tip page: tip.jrbussard.com/<handle>
const HANDLE_RE = /^[a-z0-9](?:[a-z0-9-]{1,28}[a-z0-9])$/;

// Names used by app routes today, or planned ones in PLAN.md (/company).
const RESERVED = new Set([
  "about", "admin", "api", "app", "billing", "company", "help", "legal", "login", "logout", "payouts",
  "privacy", "register", "settings", "signin", "signout", "signup", "sign-in", "sign-out",
  "sign-up", "support", "terms", "tip", "tips", "www",
]);

export function handleError(handle: string): string | null {
  if (!HANDLE_RE.test(handle)) return "Pick a link name of 3–30 letters, numbers or dashes.";
  if (RESERVED.has(handle)) return "That link name is reserved. Try another.";
  return null;
}
