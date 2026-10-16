import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AuthFrame, VerifyPanel } from "@/components/account/AuthForms";
import { isPublicMode } from "@/lib/accounts/mode";

export const metadata: Metadata = { title: "Confirm email" };
export const dynamic = "force-dynamic";

export default async function VerifyPage({ searchParams }: PageProps<"/verify">) {
  if (!isPublicMode()) notFound();
  const token = (await searchParams).token;
  return (
    <AuthFrame title="Confirm email">
      <VerifyPanel token={typeof token === "string" && token ? token : null} />
    </AuthFrame>
  );
}
