import Link from "next/link";
import { cardFeeCents, feesCents, PLATFORM_FEE_CENTS } from "@convex/lib/money";
import { Logo, SiteFooter } from "@/components/Brand";
import { DemoBar } from "@/components/DemoBar";
import { IconArrow, IconCheck } from "@/components/Icons";
import { money, money2 } from "@/lib/format";

const EXAMPLE_TIP = 1000;

const STEPS = [
  ["Create your link", "Add your name and job to get your own tip page."],
  ["Put out your QR code", "Print it for your badge or stand, or share the link."],
  ["Guests tip in seconds", "They scan, choose an amount and tip. No app or account."],
];

const CREW_POINTS = [
  "Anyone can start a crew. Others join with a 4-digit code or QR code.",
  "The starter chooses an even split or one by hours, shares or custom percents.",
  "Tips from before you join stay yours.",
];

const CREW_EXAMPLE: [string, string, number][] = [["Marcus", "1.5 shares", 4500], ["Dana", "1 share", 3000], ["Theo", "0.5 shares", 1500]];

function TipPreview() {
  return (
    <div className="preview" aria-hidden>
      <div className="row between">
        <div>
          <div className="t-title" style={{ fontSize: 24 }}>Tip Marcus</div>
          <div className="small muted">Valet at The Harbor Hotel</div>
        </div>
        <span className="avatar">MH</span>
      </div>
      <div className="stack">
        <span className="label">Amount</span>
        <div className="presets">
          <span className="preset center">$5</span>
          <span className="preset center" style={{ background: "var(--primary)", borderColor: "var(--primary)", color: "var(--primary-ink)" }}>$10</span>
          <span className="preset center">$20</span>
          <span className="preset other center">Other</span>
        </div>
      </div>
      <div className="rows">
        <div className="line"><span>Tip</span><span>{money2(EXAMPLE_TIP)}</span></div>
        <div className="line"><span>Estimated fees</span><span>{money2(feesCents(EXAMPLE_TIP))}</span></div>
        <div className="line total"><span>Total</span><span>{money2(EXAMPLE_TIP + feesCents(EXAMPLE_TIP))}</span></div>
      </div>
      <span className="btn primary lg full">Pay {money2(EXAMPLE_TIP + feesCents(EXAMPLE_TIP))}</span>
    </div>
  );
}

export default function Home() {
  return (
    <>
      <DemoBar />
      <header className="site-head">
        <Logo />
        <nav className="site-nav" aria-label="Main">
          <a className="how" href="#how">How it works</a>
          <Link href="/app">Sign in</Link>
        </nav>
        <Link className="btn primary" href="/app">Make your tip link</Link>
      </header>
      <main className="site-main">
        <div className="hero">
          <div className="hero-copy">
            <h1 className="t-display">Good service.<br /><span className="nowrap">A simple thank-you.</span></h1>
            <p className="lead">
              Tip Jar gives valets, cart attendants and anyone else who works for tips their own tip page and QR code.
              Guests don&apos;t need an app or an account.
            </p>
            <Link className="btn primary lg" href="/app">Make your tip link<IconArrow size={18} /></Link>
            <p className="small muted">Tipping someone? Scan the QR code on their badge.</p>
          </div>
          <div className="hero-visual">
            <p className="hero-caption">Example of what a guest sees</p>
            <TipPreview />
          </div>
        </div>

        <section className="section" id="how" style={{ scrollMarginTop: 16 }}>
          <h2 className="t-section">How it works</h2>
          <div className="steps">
            {STEPS.map(([title, body], i) => (
              <div className="stack" key={title}>
                <span className="step-no">{i + 1}</span>
                <h3 className="t-sub" style={{ fontSize: 16 }}>{title}</h3>
                <p className="muted">{body}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="section split-sec">
          <div className="stack-lg">
            <h2 className="t-section">Pool tips with today&apos;s crew</h2>
            <ul className="feature-list">
              {CREW_POINTS.map((p) => <li key={p}><IconCheck size={18} /><span>{p}</span></li>)}
            </ul>
          </div>
          <div className="example">
            <div className="row between" style={{ marginBottom: 8 }}>
              <span className="t-sub">Example: {money(9000)} pool split by shares</span>
            </div>
            <div className="list">
              {CREW_EXAMPLE.map(([name, shares, cents]) => (
                <div className="line" key={name}><span>{name}, {shares}</span><span>{money2(cents)}</span></div>
              ))}
            </div>
          </div>
        </section>

        <section className="section split-sec">
          <div className="stack-lg">
            <h2 className="t-section">Fees are on the screen</h2>
            <p className="muted">
              Guests see the fees before they tip. Covering them is on by default, so the worker gets the full tip, and
              guests can turn it off. Card fees are an estimate.
            </p>
          </div>
          <div className="example">
            <div className="t-sub" style={{ marginBottom: 8 }}>Example: a {money(EXAMPLE_TIP)} tip</div>
            <div className="rows">
              <div className="line"><span>Tip</span><span>{money2(EXAMPLE_TIP)}</span></div>
              <div className="line"><span>Estimated card fee</span><span>{money2(cardFeeCents(EXAMPLE_TIP))}</span></div>
              <div className="line"><span>Tip Jar fee</span><span>{money2(PLATFORM_FEE_CENTS)}</span></div>
              <div className="line total"><span>Guest pays</span><span>{money2(EXAMPLE_TIP + feesCents(EXAMPLE_TIP))}</span></div>
            </div>
          </div>
        </section>

        <section className="section stack-lg">
          <h2 className="t-section">Tip Jar is in demo</h2>
          <p className="muted" style={{ maxWidth: "38em" }}>
            You can set up a tip page and try every step today, but payments, Tap to Pay and cash-outs are simulated. No
            card is charged and no money moves.
          </p>
          <Link className="btn" href="/app" style={{ alignSelf: "flex-start" }}>Try the demo</Link>
        </section>
      </main>
      <SiteFooter />
    </>
  );
}
