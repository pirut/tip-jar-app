import Link from "next/link";

export function LegalLinks() {
  return (
    <p className="small muted center legal-links">
      <Link href="/privacy">Privacy</Link> · <Link href="/terms">Terms</Link>
    </p>
  );
}
