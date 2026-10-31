import type { Metadata } from "next";
import { Logo, SiteFooter } from "@/components/Brand";

export const metadata: Metadata = { title: "Privacy" };

export default function Privacy() {
  return (
    <div className="center-page">
      <header className="site-head"><Logo /></header>
      <main className="prose" style={{ flex: 1, width: "100%" }}>
        <h1 className="t-title">Privacy</h1>
        <p className="small muted">Draft pending legal review. Nothing here is legal advice.</p>
        <h2>What we collect</h2>
        <p><b>Workers:</b> your email address, the name, job and workplace you enter, your tip link, and your tip, crew and payout records.</p>
        <p><b>Workers taking real tips:</b> Stripe, our payments partner, collects your identity and bank details directly on its own pages. Tip Jar doesn&apos;t receive your Social Security number, ID documents or bank account number. We store your Stripe account ID, whether Stripe has approved it, your balance, and your payout amounts and dates.</p>
        <p><b>Guests:</b> no Tip Jar account. Card and wallet details go directly to Stripe and never reach Tip Jar. We store the amount, time and fees of each tip, the card brand, and Stripe&apos;s reference numbers. Stripe&apos;s own privacy policy covers what it collects from you.</p>
        <h2>What people can see</h2>
        <p>Anyone with your tip link sees your name, job and workplace. Crew members see each other&apos;s names, jobs and shares.</p>
        <h2>Who processes it</h2>
        <p>Stripe handles payments and payouts, Clerk handles sign-in, Convex stores app data, and Vercel hosts this site.</p>
        <h2>Deleting your data</h2>
        <p>Delete your account from Edit profile in the app. If a crew you belong to is still open, including one you left, you can delete once it closes, which can take up to 24 hours. If you take real tips, you can delete once money has finished moving and your Stripe balance is zero.</p>
        <p>Deleting removes your profile and any demo tips and cash-outs. Past crew records keep a row with no name, so other people&apos;s payouts still add up. If you recently entered wrong crew codes, we keep a count of those attempts for up to 10 minutes to prevent abuse, then remove it.</p>
        <p><b>What we keep after you delete:</b> records of real payments, refunds, disputes, transfers and payouts, your Stripe account ID, and the sign-in ID linked to them. We need these for tax, accounting, disputes and fraud prevention. We also keep your link name tied to your sign-in ID permanently, so a printed QR code can never start paying someone else. Your Stripe account stays with Stripe under Stripe&apos;s own terms.</p>
      </main>
      <SiteFooter />
    </div>
  );
}
