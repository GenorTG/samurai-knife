import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import { AgentWidget } from "@/components/agent/AgentWidget";
import { UiBridge } from "@/components/shell/UiBridge";
import { Suspense } from "react";
import { AppShell } from "@/components/shell/AppShell";
import { PublicShell } from "@/components/shell/PublicShell";
import { isGuest } from "@/lib/accounts/viewer";
import { appVersion } from "@/lib/version";
import "./globals.css";

const geistSans = localFont({
  src: "./fonts/Geist-latin.woff2",
  variable: "--font-geist-sans",
  weight: "100 900",
  display: "swap",
});

const geistMono = localFont({
  src: "./fonts/GeistMono-latin.woff2",
  variable: "--font-geist-mono",
  weight: "100 900",
  display: "swap",
});

export const metadata: Metadata = {
  title: {
    default: "Smart Knife",
    template: "%s · Smart Knife",
  },
  description: "A private room of hand-made tools.",
  icons: { icon: "/blade.svg" },
};

export const viewport: Viewport = {
  themeColor: "#0a0b10",
  width: "device-width",
  initialScale: 1,
};

/** Runs before first paint: applies a saved manual theme so there is no flash. */
const THEME_INIT = `try{var t=localStorage.getItem("sk-theme");document.documentElement.dataset.theme=t==="light"?"light":"dark"}catch(e){document.documentElement.dataset.theme="dark"}`;

export default async function RootLayout({ children }: LayoutProps<"/">) {
  // Public mode, no session: the welcome/auth frame only. Tool and account pages redirect guests to /login themselves
  // (a layout is not re-rendered on client navigation, so it can choose the frame but never be the gate).
  const guest = await isGuest();
  return (
    <html
      lang="en"
      data-theme="dark"
      suppressHydrationWarning
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT }} />
      </head>
      <body suppressHydrationWarning className="min-h-full bg-bg text-ink">
        {guest ? (
          <PublicShell>{children}</PublicShell>
        ) : (
          <>
            <AppShell version={appVersion()}>{children}</AppShell>
            <AgentWidget />
            <Suspense fallback={null}>
              <UiBridge />
            </Suspense>
          </>
        )}
      </body>
    </html>
  );
}
