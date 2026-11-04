'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
import { ArrowDown, ArrowUp, Loader2, Repeat } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Switch } from '@/components/ui/switch';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { createClient } from '@/lib/supabase/client';

interface RotationMember {
  user_id: string;
  full_name: string;
  role: string;
}

/**
 * Lead rotation (migration 057): leads nobody owns go, in turn, to the
 * attendants picked here. Only among the ones linked to the number the
 * customer wrote to, when any of them is. Owner / admin edit it.
 */
export function LeadRotation({
  accountId,
  members,
  canEdit,
}: {
  accountId: string;
  members: RotationMember[];
  canEdit: boolean;
}) {
  const t = useTranslations('Settings.rotation');
  const [loaded, setLoaded] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [order, setOrder] = useState<string[]>([]);
  const [lastUserId, setLastUserId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    let cancelled = false;
    createClient()
      .from('lead_rotation')
      .select('enabled, member_ids, last_user_id')
      .eq('account_id', accountId)
      .maybeSingle()
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error) console.warn('[rotation] load failed:', error.message);
        const row = data as { enabled?: boolean; member_ids?: string[]; last_user_id?: string | null } | null;
        setEnabled(row?.enabled === true);
        setOrder(row?.member_ids ?? []);
        setLastUserId(row?.last_user_id ?? null);
        setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [accountId]);

  const eligible = members.filter((m) => m.role !== 'viewer');
  const nameOf = (id: string) => eligible.find((m) => m.user_id === id)?.full_name ?? '';
  const picked = order.filter((id) => eligible.some((m) => m.user_id === id));
  const unpicked = eligible.filter((m) => !picked.includes(m.user_id));
  const nextUp = (() => {
    if (picked.length === 0) return null;
    const pos = lastUserId ? order.indexOf(lastUserId) : -1;
    return picked.find((id) => order.indexOf(id) > pos) ?? picked[0];
  })();

  function toggle(id: string, on: boolean) {
    setOrder((prev) => (on ? [...prev.filter((x) => x !== id), id] : prev.filter((x) => x !== id)));
    setDirty(true);
  }

  function move(id: string, delta: number) {
    setOrder((prev) => {
      const list = prev.filter((x) => picked.includes(x));
      const i = list.indexOf(id);
      const j = i + delta;
      if (i < 0 || j < 0 || j >= list.length) return prev;
      [list[i], list[j]] = [list[j], list[i]];
      return list;
    });
    setDirty(true);
  }

  async function save(nextEnabled = enabled) {
    if (nextEnabled && picked.length === 0) {
      toast.error(t('pickSomeone'));
      return;
    }
    setSaving(true);
    const { error } = await createClient()
      .from('lead_rotation')
      .upsert(
        { account_id: accountId, enabled: nextEnabled, member_ids: picked, updated_at: new Date().toISOString() },
        { onConflict: 'account_id' },
      );
    setSaving(false);
    if (error) {
      console.error('[rotation] save failed:', error.message);
      toast.error(t('saveFailed'));
      return;
    }
    setEnabled(nextEnabled);
    setOrder(picked);
    setDirty(false);
    toast.success(nextEnabled ? t('savedOn') : t('savedOff'));
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-foreground">
          <Repeat className="size-5 text-primary" />
          {t('title')}
        </CardTitle>
        <CardDescription className="text-muted-foreground">{t('description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {!loaded ? (
          <Loader2 className="size-4 animate-spin text-muted-foreground" />
        ) : (
          <>
            <label className="flex items-center gap-2 text-sm text-foreground">
              <Switch
                checked={enabled}
                disabled={!canEdit || saving}
                onCheckedChange={(v) => void save(v)}
              />
              {enabled ? t('on') : t('off')}
            </label>

            <div className="space-y-1.5">
              <p className="text-xs font-medium text-muted-foreground">{t('orderTitle')}</p>
              {picked.length === 0 && <p className="text-sm text-muted-foreground">{t('nobody')}</p>}
              {picked.map((id, i) => (
                <div key={id} className="flex items-center gap-2 rounded-md border border-border px-2 py-1.5 text-sm">
                  <span className="w-5 text-xs text-muted-foreground">{i + 1}.</span>
                  <span className="flex-1 truncate text-foreground">
                    {nameOf(id)}
                    {enabled && id === nextUp && (
                      <span className="ml-2 text-xs text-primary">{t('nextUp')}</span>
                    )}
                  </span>
                  {canEdit && (
                    <>
                      <Button size="icon" variant="ghost" className="size-7" disabled={i === 0} onClick={() => move(id, -1)} aria-label={t('moveUp')}>
                        <ArrowUp className="size-3.5" />
                      </Button>
                      <Button size="icon" variant="ghost" className="size-7" disabled={i === picked.length - 1} onClick={() => move(id, 1)} aria-label={t('moveDown')}>
                        <ArrowDown className="size-3.5" />
                      </Button>
                      <Checkbox checked onCheckedChange={() => toggle(id, false)} aria-label={t('remove')} />
                    </>
                  )}
                </div>
              ))}
            </div>

            {canEdit && unpicked.length > 0 && (
              <div className="space-y-1.5">
                <p className="text-xs font-medium text-muted-foreground">{t('addTitle')}</p>
                <div className="grid gap-1.5 sm:grid-cols-2">
                  {unpicked.map((m) => (
                    <label key={m.user_id} className="flex items-center gap-2 text-sm text-foreground">
                      <Checkbox checked={false} onCheckedChange={(v) => toggle(m.user_id, v === true)} />
                      <span className="truncate">{m.full_name}</span>
                    </label>
                  ))}
                </div>
              </div>
            )}

            <p className="text-xs text-muted-foreground">{t('rules')}</p>

            {canEdit && dirty && (
              <Button size="sm" onClick={() => void save()} disabled={saving}>
                {saving && <Loader2 className="mr-1.5 size-3.5 animate-spin" />}
                {t('save')}
              </Button>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
