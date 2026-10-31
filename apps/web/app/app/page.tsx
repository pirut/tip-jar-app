"use client";

import { useCallback, useEffect, useState } from "react";
import { useConvexAuth, useQuery } from "convex/react";
import { useClerk } from "@clerk/nextjs";
import { api } from "@convex/_generated/api";
import { DemoBar } from "@/components/DemoBar";
import { LegalLinks } from "@/components/LegalLinks";
import { SignIn } from "@/components/SignIn";
import { ProfileForm } from "@/components/ProfileForm";
import { TipsTab } from "@/components/TipsTab";
import { CrewTab } from "@/components/CrewTab";
import { EarningsTab } from "@/components/EarningsTab";
import { initials } from "@/lib/format";

type Tab = "tips" | "crew" | "earn";

const TABS: [Tab, string, React.ReactNode][] = [
  ["tips", "Tips", <path key="i" d="M4 8h16v10a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8Zm2-4h12l2 4H4l2-4Zm6 8v4m-2-2h4" />],
  ["crew", "Crew", <path key="i" d="M9 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm-6 8c0-3 2.7-5 6-5s6 2 6 5m1-8a3 3 0 0 0 0-6m2 9c2 .6 3 2.200 3 5" />],
  ["earn", "Earnings", <path key="i" d="M5 20v-6m7 6V9m7 11V4" />],
];

const tabFromUrl = (): Tab => {
  const params = new URLSearchParams(window.location.search);
  if (params.has("join")) return "crew";
  const t = params.get("tab");
  return t === "crew" || t === "earn" ? t : "tips";
};

export default function WorkerApp() {
  const { isLoading, isAuthenticated } = useConvexAuth();
  const me = useQuery(api.workers.me, isAuthenticated ? {} : "skip");
  const crew = useQuery(api.crews.current, isAuthenticated ? {} : "skip");
  const { signOut } = useClerk();
  const [tab, setTabState] = useState<Tab>("tips");
  const [editing, setEditing] = useState(false);

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

  if (isLoading || (isAuthenticated && me === undefined))
    return (
      <main className="page" aria-busy="true">
        <span className="wordmark">Tip Jar</span>
        <div className="skel big-line" /><div className="skel tall" />
      </main>
    );
  if (!isAuthenticated)
    return (
      <>
        <DemoBar />
        <main className="page"><a className="wordmark" href="/">Tip Jar</a><SignIn /><LegalLinks /></main>
      </>
    );
  const worker = me?.worker;
  if (!worker || editing)
    return (
      <>
        <DemoBar />
        <main className="page">
          <span className="wordmark">Tip Jar</span>
          <ProfileForm initial={worker ?? undefined} onDone={() => setEditing(false)} onCancel={worker ? () => setEditing(false) : undefined} onSignOut={leave} />
          <LegalLinks />
        </main>
      </>
    );

  return (
    <>
      <DemoBar />
      <main className="page has-tabs">
        <div className="row between">
          <button className="row btn ghost profile-btn" onClick={() => setEditing(true)} aria-label="Edit profile">
            <span className="avatar sm">{initials(worker.name)}</span><b>{worker.name}</b>
          </button>
          <button className="chip" onClick={() => setTab("crew")}>
            <span className={crew?.crew ? "dot" : "dot off"} />{crew?.crew ? "In crew" : "Solo today"}
          </button>
        </div>
        {tab === "tips" && <TipsTab handle={worker.handle} name={worker.name} />}
        {tab === "crew" && <CrewTab />}
        {tab === "earn" && <EarningsTab />}
      </main>
      <nav className="tabs" aria-label="Sections">
        {TABS.map(([k, l, icon]) => (
          <button key={k} aria-current={tab === k ? "page" : undefined} onClick={() => setTab(k)}>
            <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>{icon}</svg>
            {l}
          </button>
        ))}
      </nav>
    </>
  );
}
