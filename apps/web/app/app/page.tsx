"use client";

import { useCallback, useEffect, useState } from "react";
import { useAction, useConvexAuth, useMutation, useQuery } from "convex/react";
import { useClerk, useUser } from "@clerk/nextjs";
import { api } from "@convex/_generated/api";
import { LegalLinks, Logo } from "@/components/Brand";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { DemoBar, MoneyBar } from "@/components/DemoBar";
import { IconCrew, IconEarnings, IconTips } from "@/components/Icons";
import { SignIn } from "@/components/SignIn";
import { ProfileForm } from "@/components/ProfileForm";
import { TipsTab } from "@/components/TipsTab";
import { CrewTab } from "@/components/CrewTab";
import { EarningsTab } from "@/components/EarningsTab";
import { initials } from "@/lib/format";

type Tab = "tips" | "crew" | "earn" | "profile";

const TABS: [Tab, string, React.ReactNode][] = [
  ["tips", "Tips", <IconTips key="i" />],
  ["crew", "Crew", <IconCrew key="i" />],
  ["earn", "Earnings", <IconEarnings key="i" />],
];

const tabFromUrl = (): Tab => {
  const params = new URLSearchParams(window.location.search);
  if (params.has("join")) return "crew";
  const t = params.get("tab");
  return t === "crew" || t === "earn" || t === "profile" ? t : "tips";
};

// Deleting takes two steps: Tip Jar's data, then the Clerk sign-in. "failed" means only the first worked.
type Deletion = "data" | "signin" | "failed" | null;

function Loading() {
  return (
    <main className="onboard" aria-busy="true" aria-label="Loading">
      <div className="skel" style={{ width: 96, height: 24 }} />
      <div className="skel" style={{ width: "50%", height: 36 }} />
      <div className="skel" style={{ height: 240 }} />
    </main>
  );
}

export default function WorkerApp() {
  const { isLoading, isAuthenticated } = useConvexAuth();
  const me = useQuery(api.workers.me, isAuthenticated ? {} : "skip");
  const crew = useQuery(api.crews.current, isAuthenticated ? {} : "skip");
  const removeData = useMutation(api.workers.deleteAccount);
  const payments = useQuery(api.payments.status, isAuthenticated ? {} : "skip");
  const refreshBalance = useAction(api.paymentsNode.refreshBalance);
  const { user } = useUser();
  const { signOut } = useClerk();
  const [tab, setTabState] = useState<Tab>("tips");
  const [deletion, setDeletion] = useState<Deletion>(null);
  const [confirmSignInDeletion, setConfirmSignInDeletion] = useState(false);

  // Tabs live in the URL, so reload and the Back button behave.
  useEffect(() => {
    const sync = () => setTabState(tabFromUrl());
    sync();
    window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
  }, []);
  const setTab = useCallback((t: Tab) => {
    setTabState(t);
    window.history.pushState(null, "", t === "tips" ? "/app" : `/app?tab=${t}`);
  }, []);
  const leave = () => signOut({ redirectUrl: "/app" });

  async function deleteSignIn() {
    setDeletion("signin");
    try {
      if (!user) throw new Error("Sign in again to finish deleting your account.");
      await user.delete();
      // The session went with the user, so there's nothing left to sign out of.
      window.location.assign("/app");
    } catch {
      setDeletion("failed");
    }
  }

  // A failure here means nothing was deleted; ProfileForm shows the reason.
  async function deleteAccount() {
    setDeletion("data");
    try {
      // Deleting is refused while there's money in Stripe, so ask Stripe rather than trust an old figure.
      if (payments?.hasAccount) await refreshBalance({});
      await removeData({});
    } catch (e) {
      setDeletion(null);
      throw e;
    }
    await deleteSignIn();
  }

  if (deletion === "failed" || deletion === "signin" || (deletion === "data" && !me?.worker))
    return (
      <div className="center-page">
        <DemoBar />
        <div className="site-head"><Logo /></div>
        {deletion === "failed" ? (
          <main className="center-body" role="alert">
            <h1 className="t-title">Your account is only partly deleted</h1>
            <p className="muted">Your Tip Jar profile and demo records are gone, but your sign-in account couldn&apos;t be removed. Try again below. If you need to sign in again, choose Delete my sign-in account on the setup screen.</p>
            <div className="row wrap">
              <button className="btn primary" onClick={deleteSignIn}>Try again</button>
              <button className="btn" onClick={leave}>Sign out</button>
            </div>
          </main>
        ) : (
          <main className="center-body" role="status">
            <div className="row"><span className="spinner" aria-hidden />Deleting your account…</div>
          </main>
        )}
      </div>
    );

  if (isLoading || (isAuthenticated && me === undefined)) return <Loading />;
  if (!isAuthenticated)
    return (
      <>
        <DemoBar />
        <SignIn />
      </>
    );
  const worker = me?.worker;
  if (!worker)
    return (
      <>
        <DemoBar />
        <div className="site-head"><Logo /></div>
        <main className="onboard">
          <ProfileForm onSignOut={leave} />
          <section className="section-line stack">
            <h2 className="t-sub">Your sign-in account</h2>
            <p className="muted">No tip profile is connected to this account. You can delete your sign-in account without creating a profile, including after an earlier deletion was interrupted.</p>
            <button className="btn" onClick={() => setConfirmSignInDeletion(true)}>Delete my sign-in account</button>
          </section>
          <ConfirmDialog open={confirmSignInDeletion} title="Delete your sign-in account?" confirmLabel="Delete sign-in account" cancelLabel="Keep account" danger onCancel={() => setConfirmSignInDeletion(false)} onConfirm={() => { setConfirmSignInDeletion(false); void deleteSignIn(); }}>
            This removes your sign-in account and email from Clerk. This can&apos;t be undone.
          </ConfirmDialog>
          <LegalLinks />
        </main>
      </>
    );

  const userButton = (
    <button className="user-btn" onClick={() => setTab("profile")} aria-label="Edit profile">
      <span className="avatar sm">{initials(worker.name)}</span>
      <span className="sidebar-name">{worker.name}</span>
    </button>
  );
  const crewStatus = (
    <button className="status" onClick={() => setTab("crew")}>
      <span className={crew?.crew ? "dot" : "dot off"} />{crew?.crew ? "In a crew" : "Solo today"}
    </button>
  );

  return (
    <>
      {payments !== undefined && <MoneyBar stage={payments?.stage} testMode={payments?.testMode} />}
      <div className="shell">
        <header className="appbar">
          <Logo href="/app" onNavigate={(e) => { e.preventDefault(); setTab("tips"); }} />
          <div className="row" style={{ gap: 4 }}>{crewStatus}<button className="user-btn" onClick={() => setTab("profile")} aria-label="Edit profile"><span className="avatar sm">{initials(worker.name)}</span></button></div>
        </header>
        <aside className="sidebar">
          <div className="sidebar-brand"><Logo href="/app" onNavigate={(e) => { e.preventDefault(); setTab("tips"); }} /></div>
          <nav className="tabs" aria-label="Sections">
            {TABS.map(([k, l, icon]) => (
              <button key={k} aria-current={tab === k ? "page" : undefined} onClick={() => setTab(k)}>{icon}{l}</button>
            ))}
          </nav>
          <div className="sidebar-foot">{crewStatus}{userButton}<LegalLinks /></div>
        </aside>
        <main className="content">
          {tab === "tips" && <TipsTab handle={worker.handle} name={worker.name} />}
          {tab === "crew" && <CrewTab />}
          {tab === "earn" && <EarningsTab />}
          {tab === "profile" && <ProfileForm initial={worker} email={user?.primaryEmailAddress?.emailAddress} keepsRecords={!!payments?.hasAccount} onDone={() => setTab("tips")} onCancel={() => setTab("tips")} onSignOut={leave} onDelete={deleteAccount} />}
        </main>
      </div>
    </>
  );
}
