import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AuthFrame, VerifyPanel } from "@/components/account/AuthForms";
import { isPublicMode } from "@/lib/accounts/mode";
import { getT } from "@/lib/i18n/server";

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getT();
  return { title: t("Confirm email") };
}
export const dynamic = "force-dynamic";

export default async function VerifyPage({ searchParams }: PageProps<"/verify">) {
  const { t } = await getT();
  if (!isPublicMode()) notFound();
  const token = (await searchParams).token;
  return (
    <AuthFrame title={t("Confirm email")}>
      <VerifyPanel token={typeof token === "string" && token ? token : null} />
    </AuthFrame>
  );
}
