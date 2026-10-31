import type { Metadata } from "next";
import { Logo, SiteFooter } from "@/components/Brand";

export const metadata: Metadata = { title: "Privacy" };

export default function Privacy() {
  return (
    <div className="center-page">
      <header className="site-head"><Logo /></header>
      <main className="prose" style={{ flex: 1, width: "100%" }}>
        <h1 className="t-title">Privacy</h1>
        <p className="small muted">Draft for the demo period, pending legal review.</p>
        <h2>What we collect</h2>
        <p><b>Workers:</b> your email address, the name, job and workplace you enter, your tip link, and your tip, crew and cash-out records.</p>
        <p><b>Guests:</b> no account and no personal details. We record the amount and time of each tip.</p>
        <h2>What people can see</h2>
        <p>Anyone with your tip link sees your name, job and workplace. Crew members see each other&apos;s names, jobs and shares.</p>
        <h2>Who processes it</h2>
        <p>Clerk handles sign-in, Convex stores app data, and Vercel hosts this site. During the demo period no real payments are taken.</p>
        <h2>Deleting your data</h2>
        <p>Delete your account from Edit profile in the app. If a crew you belong to is still open, including one you left, you can delete once it closes, which can take up to 24 hours.</p>
        <p>Deleting removes your profile, tips and cash-outs. Past crew records keep a row with no name, so other people&apos;s payouts still add up. If you recently entered wrong crew codes, we keep a count of those attempts for up to 10 minutes to prevent abuse, then remove it.</p>
      </main>
      <SiteFooter />
    </div>
  );
}
