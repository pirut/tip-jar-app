"use client";

import { useState } from "react";
import { useConvexAuth, useQuery } from "convex/react";
import { useAuthActions } from "@convex-dev/auth/react";
import { api } from "@convex/_generated/api";
import { SignIn } from "@/components/SignIn";
import { ProfileForm } from "@/components/ProfileForm";
import { TipsTab } from "@/components/TipsTab";
import { CrewTab } from "@/components/CrewTab";
import { EarningsTab } from "@/components/EarningsTab";
import { initials } from "@/lib/format";

type Tab = "tips" | "crew" | "earn";

export default function WorkerApp() {
  const { isLoading, isAuthenticated } = useConvexAuth();
  const me = useQuery(api.workers.me, isAuthenticated ? {} : "skip");
  const { signOut } = useAuthActions();
  const [tab, setTab] = useState<Tab>("tips");
  const [editing, setEditing] = useState(false);

  if (isLoading || (isAuthenticated && me === undefined)) return <main className="page"><p className="muted">Loading…</p></main>;
  if (!isAuthenticated) return <main className="page"><span className="wordmark">Tip Jar</span><SignIn /></main>;
  const worker = me?.worker;
  if (!worker || editing)
    return (
      <main className="page">
        <span className="wordmark">Tip Jar</span>
        <ProfileForm initial={worker ?? undefined} onDone={() => setEditing(false)} />
        <button className="btn ghost" style={{ alignSelf: "center" }} onClick={() => (worker ? setEditing(false) : signOut())}>{worker ? "Cancel" : "Sign out"}</button>
      </main>
    );

  return (
    <main className="page">
      <div className="row between">
        <button className="row btn ghost" style={{ padding: 0, color: "var(--ink)" }} onClick={() => setEditing(true)} aria-label="Edit profile">
          <span className="avatar sm">{initials(worker.name)}</span><b>{worker.name}</b>
        </button>
        <button className="btn ghost small" onClick={() => signOut()}>Sign out</button>
      </div>
      {tab === "tips" && <TipsTab handle={worker.handle} />}
      {tab === "crew" && <CrewTab />}
      {tab === "earn" && <EarningsTab />}
      <nav className="tabs" aria-label="Sections">
        {([["tips", "Tips"], ["crew", "Crew"], ["earn", "Earnings"]] as [Tab, string][]).map(([k, l]) => (
          <button key={k} aria-current={tab === k ? "page" : undefined} onClick={() => setTab(k)}>{l}</button>
        ))}
      </nav>
    </main>
  );
}
