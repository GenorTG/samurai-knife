import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AuthFrame, ResetForm } from "@/components/account/AuthForms";
import { isPublicMode } from "@/lib/accounts/mode";
import { getT } from "@/lib/i18n/server";

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getT();
  return { title: t("Set a new password") };
}
export const dynamic = "force-dynamic";

export default async function ResetPasswordPage({ searchParams }: PageProps<"/reset-password">) {
  const { t } = await getT();
  if (!isPublicMode()) notFound();
  const token = (await searchParams).token;
  return (
    <AuthFrame title={t("Set a new password")}>
      <ResetForm token={typeof token === "string" && token ? token : null} />
    </AuthFrame>
  );
}
