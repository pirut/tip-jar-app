import Link from "next/link";
import type { ComponentProps } from "react";

export function LogoMark({ size = 24 }: { size?: number }) {
  return (
    <svg viewBox="0 0 32 32" width={size} height={size} aria-hidden>
      <rect width="32" height="32" rx="8" fill="var(--primary)" />
      <path fill="var(--primary-ink)" d="M11 6.5h10a1.25 1.25 0 0 1 0 2.5H11a1.25 1.25 0 0 1 0-2.5Zm1 3.5h8c2.2 1.5 3.5 3.3 3.5 5.8V22a3.5 3.5 0 0 1-3.5 3.5h-8A3.5 3.5 0 0 1 8.5 22v-6.2C8.5 13.3 9.8 11.5 12 10Z" />
      <circle cx="16" cy="18" r="3" fill="var(--primary)" />
    </svg>
  );
}

export function Logo({ href = "/", onNavigate }: { href?: string; onNavigate?: ComponentProps<typeof Link>["onNavigate"] }) {
  return <Link className="logo" href={href} onNavigate={onNavigate}><LogoMark />Tip Jar</Link>;
}

export function LegalLinks() {
  return (
    <nav className="legal-links" aria-label="Legal">
      <Link href="/privacy">Privacy</Link>
      <Link href="/terms">Terms</Link>
    </nav>
  );
}

export function SiteFooter() {
  return (
    <footer className="site-foot">
      <div className="site-foot-in"><Logo /><LegalLinks /></div>
    </footer>
  );
}
