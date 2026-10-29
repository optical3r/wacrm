'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
import { Loader2, Pencil, Star, Trash2, Unplug, UserCog } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import type { DapiMember, DapiNumber } from './dapi-connect';

/**
 * Starter plan: the account's WhatsApp numbers, one per member. Owner
 * and admin see and manage every number; other members see their own.
 */
export function DapiNumbers({
  numbers,
  maxNumbers,
  canManage,
  members = [],
  onChanged,
}: {
  numbers: DapiNumber[];
  maxNumbers: number;
  canManage: boolean;
  /** Owner / admin: members a number can be linked to. */
  members?: DapiMember[];
  onChanged: () => void;
}) {
  const t = useTranslations('Settings.dapi');
  const [busy, setBusy] = useState<string | null>(null);
  const [relinking, setRelinking] = useState<string | null>(null);

  async function request(id: string, init: RequestInit, url = '/api/whatsapp/dapi') {
    setBusy(id);
    try {
      const res = await fetch(url, init);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      onChanged();
      return true;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('saveFailed'));
      return false;
    } finally {
      setBusy(null);
    }
  }

  const patch = (n: DapiNumber, body: Record<string, unknown>) =>
    request(n.id, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel_id: n.id, ...body }),
    });

  async function rename(n: DapiNumber) {
    const answer = window.prompt(t('renamePrompt'), n.label ?? '');
    if (answer === null) return;
    await patch(n, { label: answer });
  }

  async function relink(n: DapiNumber, ownerUserId: string) {
    if (!ownerUserId || ownerUserId === n.owner_user_id) {
      setRelinking(null);
      return;
    }
    if (await patch(n, { owner_user_id: ownerUserId })) {
      setRelinking(null);
      toast.success(t('ownerChanged'));
    }
  }

  async function toggleGroups(n: DapiNumber, on: boolean) {
    if (await patch(n, { read_groups: on })) toast.success(on ? t('groupsOnToast') : t('groupsOffToast'));
  }

  async function disconnect(n: DapiNumber) {
    if (!window.confirm(t('disconnectConfirm'))) return;
    if (await request(n.id, { method: 'DELETE' }, `/api/whatsapp/dapi?channel_id=${encodeURIComponent(n.id)}`)) {
      toast.success(t('disconnectedToast'));
    }
  }

  async function remove(n: DapiNumber) {
    if (!window.confirm(t('removeConfirm'))) return;
    await request(n.id, { method: 'DELETE' }, `/api/whatsapp/dapi?channel_id=${encodeURIComponent(n.id)}&remove=1`);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-foreground">{t('numbersTitle')}</CardTitle>
        <CardDescription className="text-muted-foreground">
          {canManage ? t('numbersDesc', { count: numbers.length, max: maxNumbers }) : t('numbersDescOwn')}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {numbers.length === 0 && <p className="text-sm text-muted-foreground">{t('noNumbers')}</p>}
        {numbers.map((n) => {
          const name = n.label || n.owner_name || t('unknownOwner');
          const working = busy === n.id;
          const canEditThis = canManage || n.mine;
          return (
            <div
              key={n.id}
              className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border p-3"
            >
              <div className="min-w-0">
                <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-foreground">
                  {name}
                  {n.mine && <Badge variant="outline">{t('you')}</Badge>}
                  {n.is_default && <Badge variant="secondary">{t('defaultBadge')}</Badge>}
                  <Badge variant={n.status === 'connected' ? 'default' : 'outline'}>
                    {n.status === 'connected' ? t('statusConnected') : t('statusDisconnected')}
                  </Badge>
                </p>
                <p className="text-xs text-muted-foreground">
                  {n.phone ? <span className="font-mono">+{n.phone}</span> : t('noPhone')}
                  {n.label && n.owner_name ? ` · ${t('ownerLine', { name: n.owner_name })}` : ''}
                </p>
                {canManage && (
                  <label className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
                    <Switch
                      checked={n.read_groups === true}
                      disabled={working || n.status !== 'connected'}
                      onCheckedChange={(v) => void toggleGroups(n, v)}
                    />
                    {t('readGroups')}
                  </label>
                )}
                {!canManage && n.read_groups && (
                  <p className="mt-1 text-xs text-muted-foreground">{t('readGroupsOn')}</p>
                )}
                {relinking === n.id && (
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <select
                      aria-label={t('changeOwnerLabel')}
                      defaultValue={n.owner_user_id ?? ''}
                      disabled={working}
                      onChange={(e) => void relink(n, e.target.value)}
                      className="h-8 rounded-md border border-input bg-background px-2 text-sm text-foreground"
                    >
                      {!n.owner_user_id && <option value="">{t('unknownOwner')}</option>}
                      {members.map((m) => {
                        const taken = m.user_id !== n.owner_user_id && numbers.some((x) => x.owner_user_id === m.user_id);
                        return (
                          <option key={m.user_id} value={m.user_id} disabled={taken}>
                            {taken ? `${m.name} · ${t('hasNumber')}` : m.name}
                          </option>
                        );
                      })}
                    </select>
                    <Button size="sm" variant="ghost" onClick={() => setRelinking(null)}>
                      {t('cancel')}
                    </Button>
                  </div>
                )}
              </div>
              {canEditThis && (
                <div className="flex flex-wrap gap-1.5">
                  {working && <Loader2 className="size-4 animate-spin self-center" />}
                  <Button size="sm" variant="ghost" disabled={working} onClick={() => rename(n)}>
                    <Pencil className="mr-1.5 size-3.5" />
                    {t('rename')}
                  </Button>
                  {canManage && members.length > 0 && (
                    <Button size="sm" variant="ghost" disabled={working} onClick={() => setRelinking(n.id)}>
                      <UserCog className="mr-1.5 size-3.5" />
                      {t('changeOwner')}
                    </Button>
                  )}
                  {canManage && !n.is_default && (
                    <Button size="sm" variant="ghost" disabled={working} onClick={() => patch(n, { is_default: true })}>
                      <Star className="mr-1.5 size-3.5" />
                      {t('makeDefault')}
                    </Button>
                  )}
                  {n.status === 'connected' && !n.mine && (
                    <Button size="sm" variant="outline" disabled={working} onClick={() => disconnect(n)}>
                      <Unplug className="mr-1.5 size-3.5" />
                      {t('disconnect')}
                    </Button>
                  )}
                  {canManage && n.status !== 'connected' && (
                    <Button size="sm" variant="outline" disabled={working} onClick={() => remove(n)}>
                      <Trash2 className="mr-1.5 size-3.5" />
                      {t('remove')}
                    </Button>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
