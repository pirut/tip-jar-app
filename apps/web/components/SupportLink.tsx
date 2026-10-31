"use client";

import { useQuery } from "convex/react";
import { api } from "@convex/_generated/api";

export function SupportLink({ reference }: { reference?: string }) {
  const support = useQuery(api.payments.supportInfo, {});
  if (!support?.email) return null;
  const subject = reference ? `Tip Jar payment ${reference}` : "Tip Jar support";
  return <a href={`mailto:${support.email}?subject=${encodeURIComponent(subject)}`}>Contact support</a>;
}
