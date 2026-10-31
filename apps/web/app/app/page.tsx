"use client";

import { useCallback, useEffect, useState } from "react";
import { useConvexAuth, useMutation, useQuery } from "convex/react";
import { useClerk, useUser } from "@clerk/nextjs";
import { api } from "@convex/_generated/api";
import { LegalLinks, Logo } from "@/components/Brand";
import { DemoBar } from "@/components/DemoBar";
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
  const { user } = useUser();
  const { signOut } = useClerk();
  const [tab, setTabState] = useState<Tab>("tips");
  const [deletion, setDeletion] = useState<Deletion>(null);

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
      await user?.delete();
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
            <p className="muted">Your Tip Jar profile, tips and cash-outs are gone, but your sign-in account couldn&apos;t be removed. You may need to sign in again first.</p>
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
      <DemoBar />
      <div className="shell">
        <header className="appbar">
          <Logo href="/app" />
          <div className="row" style={{ gap: 4 }}>{crewStatus}<button className="user-btn" onClick={() => setTab("profile")} aria-label="Edit profile"><span className="avatar sm">{initials(worker.name)}</span></button></div>
        </header>
        <aside className="sidebar">
          <div className="sidebar-brand"><Logo href="/app" /></div>
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
          {tab === "profile" && <ProfileForm initial={worker} email={user?.primaryEmailAddress?.emailAddress} onDone={() => setTab("tips")} onCancel={() => setTab("tips")} onSignOut={leave} onDelete={deleteAccount} />}
        </main>
      </div>
    </>
  );
}
