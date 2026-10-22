import type { Metadata } from "next";
import { LegalDocument } from "@/components/legal/LegalDocument";

export const metadata: Metadata = { title: "Privacy notice" };
export const dynamic = "force-dynamic";

/** Public in both modes (no requireSignIn): the text must be readable before an account exists. */
export default async function Page({ searchParams }: PageProps<"/privacy">) {
  const params = await searchParams;
  const text = (name: string) => (typeof params[name] === "string" ? (params[name] as string) : undefined);
  return <LegalDocument doc="privacy" lang={text("lang")} version={text("version")} edition={text("edition")} />;
}
