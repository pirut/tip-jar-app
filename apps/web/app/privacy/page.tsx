import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = { title: "Privacy" };

export default function Privacy() {
  return (
    <main className="page prose">
      <Link className="wordmark" href="/">Tip Jar</Link>
      <h1>Privacy</h1>
      <p className="small muted">Draft for the demo period, pending legal review.</p>
      <h2>What we collect</h2>
      <p><b>Workers:</b> your email address, the name, job and workplace you enter, your tip link, and your tip, crew and cash-out records.</p>
      <p><b>Guests:</b> no account and no personal details. We record the amount and time of each tip.</p>
      <h2>What people can see</h2>
      <p>Anyone with your tip link sees your name, job and workplace. Crew members see each other&apos;s names, jobs and shares.</p>
      <h2>Who processes it</h2>
      <p>Clerk handles sign-in, Convex stores app data, and Vercel hosts this site. During the demo period no real payments are taken.</p>
      <h2>Deleting your data</h2>
      <p>Delete your account any time from Edit profile in the app. That removes your profile, tips and cash-outs. Past crew records keep a row with no name, so other people&apos;s payouts still add up.</p>
    </main>
  );
}
