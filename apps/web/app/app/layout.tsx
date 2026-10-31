import type { Metadata } from "next";
import { ClerkProvider } from "@clerk/nextjs";
import { WorkerProviders } from "@/components/WorkerProviders";

export const metadata: Metadata = { title: "Your tips", robots: { index: false } };

const appearance = {
  variables: {
    colorPrimary: "var(--green)",
    colorPrimaryForeground: "var(--green-ink)",
    colorBackground: "var(--surface)",
    colorForeground: "var(--ink)",
    colorMutedForeground: "var(--muted)",
    colorInput: "var(--surface)",
    colorInputForeground: "var(--ink)",
    colorBorder: "var(--control)",
    colorDanger: "var(--warn)",
    fontFamily: "var(--body)",
    fontSize: "16px",
    borderRadius: "12px",
  },
  elements: {
    rootBox: { width: "100%" },
    cardBox: { width: "100%", boxShadow: "none", border: "1px solid var(--line)", borderRadius: "18px" },
    card: { boxShadow: "none" },
    headerTitle: { fontFamily: "var(--display)", fontSize: "26px", fontWeight: 800, textTransform: "uppercase" },
    formButtonPrimary: { minHeight: "50px", backgroundImage: "none", boxShadow: "none", fontSize: "16px", fontWeight: 600 },
    formFieldInput: { minHeight: "48px", fontSize: "16px" },
    socialButtonsBlockButton: { minHeight: "48px" },
    otpCodeFieldInput: { minHeight: "48px", fontSize: "20px" },
  },
};

const localization = {
  signIn: { start: { titleCombined: "Start getting tipped", subtitleCombined: "Sign in or create your account" } },
};

export default function WorkerLayout({ children }: { children: React.ReactNode }) {
  return (
    <ClerkProvider appearance={appearance} localization={localization}>
      <WorkerProviders>{children}</WorkerProviders>
    </ClerkProvider>
  );
}
