import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AuthFrame, ResetForm } from "@/components/account/AuthForms";
import { isPublicMode } from "@/lib/accounts/mode";

export const metadata: Metadata = { title: "Set a new password" };
export const dynamic = "force-dynamic";

export default async function ResetPasswordPage({ searchParams }: PageProps<"/reset-password">) {
  if (!isPublicMode()) notFound();
  const token = (await searchParams).token;
  return (
    <AuthFrame title="Set a new password">
      <ResetForm token={typeof token === "string" && token ? token : null} />
    </AuthFrame>
  );
}
