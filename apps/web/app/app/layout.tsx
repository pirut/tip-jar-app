import type { Metadata } from "next";
import { ClerkProvider } from "@clerk/nextjs";
import { WorkerProviders } from "@/components/WorkerProviders";

export const metadata: Metadata = { title: "Your tips", robots: { index: false } };

const appearance = {
  variables: {
    colorPrimary: "var(--primary)",
    colorPrimaryForeground: "var(--primary-ink)",
    colorBackground: "var(--surface)",
    colorForeground: "var(--ink)",
    colorMutedForeground: "var(--muted)",
    colorInput: "var(--surface)",
    colorInputForeground: "var(--ink)",
    colorBorder: "var(--control)",
    colorDanger: "var(--danger)",
    fontFamily: "var(--sans)",
    fontSize: "15px",
    borderRadius: "10px",
  },
  elements: {
    rootBox: { width: "100%" },
    cardBox: { width: "100%", boxShadow: "none", border: "1px solid var(--line)", borderRadius: "16px" },
    card: { boxShadow: "none" },
    headerTitle: { fontSize: "20px", fontWeight: 600, letterSpacing: "-.01em" },
    formButtonPrimary: { minHeight: "44px", backgroundImage: "none", boxShadow: "none", fontSize: "14px", fontWeight: 500 },
    formFieldInput: { minHeight: "44px", fontSize: "16px" },
    socialButtonsBlockButton: { minHeight: "44px" },
    otpCodeFieldInput: { minHeight: "44px", fontSize: "20px" },
  },
};

const localization = {
  signIn: { start: { titleCombined: "Welcome to Tip Jar", subtitleCombined: "Sign in or create your account" } },
};

export default function WorkerLayout({ children }: { children: React.ReactNode }) {
  return (
    <ClerkProvider appearance={appearance} localization={localization}>
      <WorkerProviders>{children}</WorkerProviders>
    </ClerkProvider>
  );
}
