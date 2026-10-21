import type { Metadata } from "next";
import { LegalDocument } from "@/components/legal/LegalDocument";

export const metadata: Metadata = { title: "Terms of Service" };
export const dynamic = "force-dynamic";

/** Public in both modes (no requireSignIn): the text must be readable before an account exists. */
export default async function Page({ searchParams }: PageProps<"/terms">) {
  const params = await searchParams;
  return <LegalDocument doc="terms" lang={typeof params.lang === "string" ? params.lang : undefined} />;
}
