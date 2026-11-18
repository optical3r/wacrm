'use client';

// ============================================================
// ConnectedApps — Settings → API → "Apps conectados".
//
// Apps that logged in with OAuth (the claude.ai connector, or any MCP
// client that uses login instead of a key). Admin+ sees them and can
// disconnect one; its tokens stop working on the next call.
// ============================================================

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Loader2, PlugZap, Unplug } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';

interface ConnectedApp {
  id: string;
  name: string;
  allow_writes: boolean;
  connected_by: string | null;
  created_at: string;
  last_used_at: string | null;
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export function ConnectedApps() {
  const t = useTranslations('Settings.apiKeys');
  const [apps, setApps] = useState<ConnectedApp[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/account/oauth-apps', { cache: 'no-store' });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(payload.error || t('appsLoadFailed'));
        setApps([]);
        return;
      }
      setApps((payload.apps ?? []) as ConnectedApp[]);
    } catch {
      toast.error(t('networkError'));
      setApps([]);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  async function disconnect(app: ConnectedApp) {
    setBusy(app.id);
    try {
      const res = await fetch(`/api/account/oauth-apps?id=${encodeURIComponent(app.id)}`, { method: 'DELETE' });
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        toast.error(payload.error || t('appsDisconnectFailed'));
        return;
      }
      toast.success(t('appsDisconnected', { name: app.name }));
      setApps((prev) => (prev ?? []).filter((a) => a.id !== app.id));
    } catch {
      toast.error(t('networkError'));
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card>
      <CardContent className="space-y-3 py-4">
        <div>
          <p className="text-foreground text-sm font-medium">{t('appsTitle')}</p>
          <p className="text-muted-foreground mt-0.5 text-xs">{t('appsDesc')}</p>
        </div>
        {apps === null ? (
          <Loader2 className="text-primary size-4 animate-spin" />
        ) : apps.length === 0 ? (
          <p className="text-muted-foreground flex items-center gap-2 text-xs">
            <PlugZap className="size-4" />
            {t('appsEmpty')}
          </p>
        ) : (
          <ul className="divide-border divide-y">
            {apps.map((a) => (
              <li key={a.id} className="flex flex-col gap-2 py-2.5 sm:flex-row sm:items-center sm:gap-4">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-foreground truncate text-sm font-medium">{a.name}</span>
                    <Badge className="border-primary/30 bg-primary/10 text-primary text-[10px]">
                      {a.allow_writes ? t('appsWrite') : t('appsRead')}
                    </Badge>
                  </div>
                  <p className="text-muted-foreground mt-0.5 text-xs">
                    {a.connected_by
                      ? t('appsConnectedBy', { name: a.connected_by, date: fmtDate(a.created_at) })
                      : t('appsConnectedOn', { date: fmtDate(a.created_at) })}
                    {' · '}
                    {a.last_used_at ? t('lastUsed', { date: fmtDate(a.last_used_at) }) : t('appsNeverUsed')}
                  </p>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => disconnect(a)}
                  disabled={busy === a.id}
                  className="self-start border-red-500/40 bg-red-500/10 text-red-300 hover:border-red-500/60 hover:bg-red-500/20 hover:text-red-200 sm:self-auto"
                >
                  {busy === a.id ? <Loader2 className="size-4 animate-spin" /> : <Unplug className="size-4" />}
                  {t('appsDisconnect')}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
