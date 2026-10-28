import type { Metadata } from "next";
import { senderAddress } from "@/lib/mail";
import { notFound } from "next/navigation";
import { AuthFrame, ForgotForm } from "@/components/account/AuthForms";
import { isPublicMode } from "@/lib/accounts/mode";
import { getT } from "@/lib/i18n/server";

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getT();
  return { title: t("Forgot password") };
}
export const dynamic = "force-dynamic";

export default async function ForgotPasswordPage() {
  const { t } = await getT();
  if (!isPublicMode()) notFound();
  return (
    <AuthFrame title={t("Forgot password")} intro={t("We send a link to set a new password to the address of your account.")}>
      <ForgotForm sender={senderAddress()} />
    </AuthFrame>
  );
}
