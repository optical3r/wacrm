'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
import { Loader2, Pencil, PlugZap, Star, Trash2, Unplug, Users } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Switch } from '@/components/ui/switch';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import type { DapiMember, DapiNumber } from './dapi-connect';

/**
 * Starter plan: the company's WhatsApp numbers. Owner and admin see and
 * manage every number and link any number of attendants to each one;
 * other members see the numbers they are linked to.
 */
export function DapiNumbers({
  numbers,
  maxNumbers,
  canManage,
  members = [],
  onChanged,
  onReconnect,
}: {
  numbers: DapiNumber[];
  maxNumbers: number;
  canManage: boolean;
  /** Owner / admin: members who can be linked to a number. */
  members?: DapiMember[];
  onChanged: () => void;
  /** Owner / admin: pair a disconnected number again. */
  onReconnect?: (n: DapiNumber) => void;
}) {
  const t = useTranslations('Settings.dapi');
  const [busy, setBusy] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [picked, setPicked] = useState<string[]>([]);

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

  function startEditing(n: DapiNumber) {
    setPicked(n.member_ids);
    setEditing(n.id);
  }

  async function saveMembers(n: DapiNumber) {
    if (await patch(n, { member_ids: picked })) {
      setEditing(null);
      toast.success(t('membersSaved'));
    }
  }

  async function toggleGroups(n: DapiNumber, on: boolean) {
    if (await patch(n, { read_groups: on })) toast.success(on ? t('groupsOnToast') : t('groupsOffToast'));
  }

  async function toggleSign(n: DapiNumber, on: boolean) {
    if (await patch(n, { sign_messages: on })) toast.success(on ? t('signOnToast') : t('signOffToast'));
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
        <CardTitle className="text-foreground">{canManage ? t('numbersTitle') : t('numbersTitleOwn')}</CardTitle>
        <CardDescription className="text-muted-foreground">
          {canManage ? t('numbersDesc', { count: numbers.length, max: maxNumbers }) : t('numbersDescOwn')}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {numbers.length === 0 && (
          <p className="text-sm text-muted-foreground">{canManage ? t('noNumbers') : t('noLinkedNumbers')}</p>
        )}
        {numbers.map((n) => {
          const name = n.label || (n.phone ? `+${n.phone}` : t('unnamedNumber'));
          const working = busy === n.id;
          return (
            <div key={n.id} className="space-y-2 rounded-lg border border-border p-3">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-foreground">
                    {name}
                    {n.mine && canManage && <Badge variant="outline">{t('linkedToYou')}</Badge>}
                    {n.is_default && <Badge variant="secondary">{t('defaultBadge')}</Badge>}
                    <Badge variant={n.status === 'connected' ? 'default' : 'outline'}>
                      {n.status === 'connected' ? t('statusConnected') : t('statusDisconnected')}
                    </Badge>
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {n.phone ? <span className="font-mono">+{n.phone}</span> : t('noPhone')}
                  </p>
                  <p className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
                    <Users className="size-3.5 shrink-0" />
                    {n.member_names.length > 0 ? n.member_names.join(', ') : t('noMembers')}
                  </p>
                  {!canManage && (n.read_groups || n.sign_messages) && (
                    <p className="mt-1 text-xs text-muted-foreground">
                      {[n.read_groups ? t('readGroupsOn') : null, n.sign_messages ? t('signOn') : null]
                        .filter(Boolean)
                        .join(' · ')}
                    </p>
                  )}
                </div>
                {canManage && (
                  <div className="flex flex-wrap gap-1.5">
                    {working && <Loader2 className="size-4 animate-spin self-center" />}
                    <Button size="sm" variant="ghost" disabled={working} onClick={() => startEditing(n)}>
                      <Users className="mr-1.5 size-3.5" />
                      {t('editMembers')}
                    </Button>
                    <Button size="sm" variant="ghost" disabled={working} onClick={() => rename(n)}>
                      <Pencil className="mr-1.5 size-3.5" />
                      {t('rename')}
                    </Button>
                    {!n.is_default && (
                      <Button size="sm" variant="ghost" disabled={working} onClick={() => patch(n, { is_default: true })}>
                        <Star className="mr-1.5 size-3.5" />
                        {t('makeDefault')}
                      </Button>
                    )}
                    {n.status === 'connected' ? (
                      <Button size="sm" variant="outline" disabled={working} onClick={() => disconnect(n)}>
                        <Unplug className="mr-1.5 size-3.5" />
                        {t('disconnect')}
                      </Button>
                    ) : (
                      <>
                        {onReconnect && (
                          <Button size="sm" variant="outline" disabled={working} onClick={() => onReconnect(n)}>
                            <PlugZap className="mr-1.5 size-3.5" />
                            {t('reconnect')}
                          </Button>
                        )}
                        <Button size="sm" variant="outline" disabled={working} onClick={() => remove(n)}>
                          <Trash2 className="mr-1.5 size-3.5" />
                          {t('remove')}
                        </Button>
                      </>
                    )}
                  </div>
                )}
              </div>

              {canManage && (
                <div className="flex flex-wrap gap-x-5 gap-y-2">
                  <label className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Switch
                      checked={n.sign_messages === true}
                      disabled={working}
                      onCheckedChange={(v) => void toggleSign(n, v)}
                    />
                    {t('signMessages')}
                  </label>
                  <label className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Switch
                      checked={n.read_groups === true}
                      disabled={working || n.status !== 'connected'}
                      onCheckedChange={(v) => void toggleGroups(n, v)}
                    />
                    {t('readGroups')}
                  </label>
                </div>
              )}

              {canManage && editing === n.id && (
                <div className="space-y-2 rounded-md border border-border bg-muted/30 p-3">
                  <p className="text-xs text-muted-foreground">{t('membersHint')}</p>
                  {members.length === 0 && <p className="text-sm text-muted-foreground">{t('noTeam')}</p>}
                  <div className="grid gap-1.5 sm:grid-cols-2">
                    {members.map((m) => (
                      <label key={m.user_id} className="flex items-center gap-2 text-sm text-foreground">
                        <Checkbox
                          checked={picked.includes(m.user_id)}
                          disabled={working}
                          onCheckedChange={(v) =>
                            setPicked((prev) =>
                              v === true ? [...prev, m.user_id] : prev.filter((id) => id !== m.user_id),
                            )
                          }
                        />
                        <span className="truncate">{m.name}</span>
                      </label>
                    ))}
                  </div>
                  <div className="flex gap-2">
                    <Button size="sm" disabled={working} onClick={() => void saveMembers(n)}>
                      {working && <Loader2 className="mr-1.5 size-3.5 animate-spin" />}
                      {t('save')}
                    </Button>
                    <Button size="sm" variant="ghost" disabled={working} onClick={() => setEditing(null)}>
                      {t('cancel')}
                    </Button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
