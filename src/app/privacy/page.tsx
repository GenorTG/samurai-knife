import type { Metadata } from "next";
import { LegalDocument } from "@/components/legal/LegalDocument";

export const metadata: Metadata = { title: "Privacy notice" };
export const dynamic = "force-dynamic";

/** Public in both modes (no requireSignIn): the text must be readable before an account exists. */
export default async function Page({ searchParams }: PageProps<"/privacy">) {
  const params = await searchParams;
  return <LegalDocument doc="privacy" lang={typeof params.lang === "string" ? params.lang : undefined} />;
}
