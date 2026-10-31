import { cache } from "react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { fetchQuery } from "convex/nextjs";
import { api } from "@convex/_generated/api";
import { GuestTip } from "@/components/GuestTip";

type Props = { params: Promise<{ handle: string }> };

const getWorker = cache((handle: string) => fetchQuery(api.workers.byHandle, { handle }));

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const worker = await getWorker((await params).handle);
  return worker ? { title: `Tip ${worker.name.split(" ")[0]}`, robots: { index: false } } : { title: "Not found" };
}

// Rendered on the server so a guest on a weak signal sees the worker and presets at once.
export default async function GuestTipPage({ params }: Props) {
  const { handle } = await params;
  const worker = await getWorker(handle);
  if (!worker) notFound();
  return <GuestTip handle={handle} worker={worker} />;
}
