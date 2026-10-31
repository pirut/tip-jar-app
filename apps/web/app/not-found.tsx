import Link from "next/link";
import { Logo } from "@/components/Brand";

export default function NotFound() {
  return (
    <div className="center-page">
      <div className="site-head"><Logo /></div>
      <main className="center-body">
        <h1 className="t-title">We couldn&apos;t find that person</h1>
        <p className="muted">Check the QR code or link and try again.</p>
        <Link className="btn" href="/">Go to Tip Jar</Link>
      </main>
    </div>
  );
}
