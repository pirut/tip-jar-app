import type { Metadata, Viewport } from "next";
import { Geist } from "next/font/google";
import { ConvexClientProvider } from "@/components/ConvexClientProvider";
import "./globals.css";

const sans = Geist({ subsets: ["latin"], variable: "--font-sans" });

export const metadata: Metadata = {
  metadataBase: new URL("https://tip.jrbussard.com"),
  title: { default: "Tip Jar", template: "%s · Tip Jar" },
  description: "A tip page and QR code for valets, cart attendants and anyone else who works for tips. Currently in demo.",
  openGraph: { title: "Tip Jar", description: "A tip page and QR code for people who work for tips. Guests need no app or account. Currently in demo.", siteName: "Tip Jar", type: "website" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#0e1412" },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={sans.variable}>
      <body>
        <ConvexClientProvider>{children}</ConvexClientProvider>
      </body>
    </html>
  );
}
