import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import { AgentWidget } from "@/components/agent/AgentWidget";
import { UiBridge } from "@/components/shell/UiBridge";
import { Suspense } from "react";
import { AppShell } from "@/components/shell/AppShell";
import { PublicShell } from "@/components/shell/PublicShell";
import { isGuest } from "@/lib/accounts/viewer";
import { appVersion } from "@/lib/version";
import { getLocale, getT } from "@/lib/i18n/server";
import { I18nProvider } from "@/lib/i18n/react";
import "./globals.css";

const geistSans = localFont({
  src: "./fonts/Geist-latin.woff2",
  variable: "--font-geist-sans",
  weight: "100 900",
  display: "swap",
  // The metric-adjusted fallback comes with the -ext family below (after it), so Polish letters reach Geist first.
  adjustFontFallback: false,
});

const geistMono = localFont({
  src: "./fonts/GeistMono-latin.woff2",
  variable: "--font-geist-mono",
  weight: "100 900",
  display: "swap",
  // The metric-adjusted fallback comes with the -ext family below (after it), so Polish letters reach Geist first.
  adjustFontFallback: false,
});

// Latin Extended (Polish ą ę ł ś ź ż ć ń ó, and the like): the next family in --font-sans / --font-mono, so the browser
// takes these glyphs from Geist too instead of a system font.
const geistSansExt = localFont({
  src: "./fonts/Geist-latin-ext.woff2",
  variable: "--font-geist-sans-ext",
  weight: "100 900",
  display: "swap",
  preload: false,
});

const geistMonoExt = localFont({
  src: "./fonts/GeistMono-latin-ext.woff2",
  variable: "--font-geist-mono-ext",
  weight: "100 900",
  display: "swap",
  preload: false,
});

export async function generateMetadata(): Promise<Metadata> {
  const { t, locale } = await getT();
  const description = t("A private room of hand-made tools.");
  return {
    title: {
      default: "Smart Knife",
      template: "%s · Smart Knife",
    },
    description,
    icons: { icon: "/blade.svg" },
    // Absolute Open Graph image URLs (tool showcases, docs/SHOWCASE.md) need the public address when there is one.
    metadataBase: siteUrl(),
    // Polish-first (docs/I18N.md): the page's language decides the Open Graph locale; the other one is the alternate.
    openGraph: { siteName: "Smart Knife", type: "website", description, locale: OG_LOCALE[locale], alternateLocale: [OG_LOCALE[locale === "pl" ? "en" : "pl"]] },
  };
}

const OG_LOCALE = { pl: "pl_PL", en: "en_US" } as const;

function siteUrl(): URL | undefined {
  const configured = process.env.KNIFE_PUBLIC_URL?.trim();
  if (!configured) return undefined;
  try {
    return new URL(configured);
  } catch {
    return undefined;
  }
}

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
  const locale = await getLocale();
  return (
    <html
      lang={locale}
      data-theme="dark"
      suppressHydrationWarning
      className={`${geistSans.variable} ${geistMono.variable} ${geistSansExt.variable} ${geistMonoExt.variable} h-full antialiased`}
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT }} />
      </head>
      <body suppressHydrationWarning className="min-h-full bg-bg text-ink">
        <I18nProvider locale={locale}>
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
        </I18nProvider>
      </body>
    </html>
  );
}
