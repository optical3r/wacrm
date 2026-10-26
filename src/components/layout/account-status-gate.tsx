"use client";

import { useTranslations } from "next-intl";
import { Clock, Ban, LogOut } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { LabCrmMark } from "@/components/brand/labcrm-mark";

/**
 * Full-screen stand-in for the app while the organization is not
 * active (migration 048): a new signup waiting for the platform owner's
 * approval, or a blocked organization.
 */
export function AccountStatusGate({
  status,
  email,
  onSignOut,
}: {
  status: "pending" | "blocked";
  email: string | null;
  onSignOut: () => void;
}) {
  const t = useTranslations("AccountStatusGate");
  const pending = status === "pending";
  const Icon = pending ? Clock : Ban;

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <Card className="w-full max-w-md border-border bg-card">
        <CardHeader className="items-center text-center">
          <LabCrmMark className="mb-2 h-12 w-12" />
          <CardTitle className="flex items-center justify-center gap-2 text-xl text-foreground">
            <Icon className="h-5 w-5 text-primary" />
            {pending ? t("pendingTitle") : t("blockedTitle")}
          </CardTitle>
          <CardDescription className="text-muted-foreground">
            {pending ? t("pendingDesc") : t("blockedDesc")}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col items-center gap-4">
          {email && (
            <p className="text-sm text-muted-foreground">
              {t("signedInAs", { email })}
            </p>
          )}
          <Button variant="outline" onClick={onSignOut}>
            <LogOut className="mr-2 h-4 w-4" />
            {t("signOut")}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
