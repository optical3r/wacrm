'use client';

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
import { Eye, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

interface HiddenGroup {
  id: string;
  name: string | null;
  hidden_at: string;
}

/**
 * Starter plan: WhatsApp groups an owner / admin hid from the inbox
 * (migration 052). Showing one again resumes from its next message.
 * Renders nothing while no group is hidden.
 */
export function DapiHiddenGroups() {
  const t = useTranslations('Settings.dapi');
  const [groups, setGroups] = useState<HiddenGroup[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/whatsapp/groups', { cache: 'no-store' });
      const data = await res.json().catch(() => ({}));
      if (res.ok) setGroups(data.groups ?? []);
    } catch {
      // Optional card: stay hidden on errors.
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function show(g: HiddenGroup) {
    setBusy(g.id);
    try {
      const res = await fetch('/api/whatsapp/groups', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contact_id: g.id, hidden: false }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setGroups((prev) => prev.filter((x) => x.id !== g.id));
      toast.success(t('groupShown'));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('saveFailed'));
    } finally {
      setBusy(null);
    }
  }

  if (groups.length === 0) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-foreground">{t('hiddenGroupsTitle')}</CardTitle>
        <CardDescription className="text-muted-foreground">{t('hiddenGroupsDesc')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {groups.map((g) => (
          <div key={g.id} className="flex items-center justify-between gap-3 rounded-lg border border-border p-3">
            <span className="truncate text-sm text-foreground">{g.name || t('unnamedGroup')}</span>
            <Button size="sm" variant="outline" disabled={busy === g.id} onClick={() => void show(g)}>
              {busy === g.id ? <Loader2 className="mr-1.5 size-3.5 animate-spin" /> : <Eye className="mr-1.5 size-3.5" />}
              {t('showGroup')}
            </Button>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
