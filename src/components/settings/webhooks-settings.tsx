'use client';

// ============================================================
// WebhooksSettings — Settings → API e MCP → Webhooks.
//
// Register https endpoints, pick the events, switch them on and off,
// and look at the latest deliveries. The signing secret is shown once,
// right after creation (only an encrypted copy is kept). admin+.
// ============================================================

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { ChevronDown, ChevronUp, Copy, Loader2, Plus, Trash2, Webhook } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { WEBHOOK_EVENTS, WEBHOOK_EVENT_LABELS_PT, type WebhookEvent } from '@/lib/webhooks/events';

interface Endpoint {
  id: string;
  url: string;
  events: string[];
  is_active: boolean;
  last_delivery_at: string | null;
  failure_count: number;
  created_at: string;
}

interface Delivery {
  id: number;
  event: string;
  ok: boolean;
  status_code: number | null;
  error: string | null;
  duration_ms: number | null;
  created_at: string;
}

function fmtDateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function Deliveries({ endpointId }: { endpointId: string }) {
  const t = useTranslations('Settings.apiKeys');
  const [rows, setRows] = useState<Delivery[] | null>(null);
  useEffect(() => {
    fetch(`/api/account/webhooks/${endpointId}/deliveries`, { cache: 'no-store' })
      .then((r) => r.json())
      .then((d) => setRows((d.deliveries ?? []) as Delivery[]))
      .catch(() => setRows([]));
  }, [endpointId]);
  if (!rows) return <Loader2 className="text-primary size-4 animate-spin" />;
  if (rows.length === 0) return <p className="text-muted-foreground text-xs">{t('whNoDeliveries')}</p>;
  return (
    <ul className="space-y-1">
      {rows.map((d) => (
        <li key={d.id} className="text-muted-foreground flex flex-wrap gap-x-2 font-mono text-[11px]">
          <span className={d.ok ? 'text-emerald-400' : 'text-red-400'}>{d.ok ? 'OK' : t('whFailed')}</span>
          <span>{d.status_code ?? '—'}</span>
          <span className="text-foreground">{d.event}</span>
          <span>{fmtDateTime(d.created_at)}</span>
          {d.duration_ms != null && <span>{d.duration_ms} ms</span>}
          {d.error && <span className="text-red-400/80">{d.error}</span>}
        </li>
      ))}
    </ul>
  );
}

export function WebhooksSettings() {
  const t = useTranslations('Settings.apiKeys');
  const [items, setItems] = useState<Endpoint[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/account/webhooks', { cache: 'no-store' });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(payload.error || t('whLoadFailed'));
        setItems([]);
        return;
      }
      setItems(payload.webhooks as Endpoint[]);
    } catch {
      toast.error(t('networkError'));
      setItems([]);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  async function setActive(e: Endpoint, isActive: boolean) {
    setBusy(e.id);
    try {
      const res = await fetch(`/api/account/webhooks/${e.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ is_active: isActive }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(payload.error || t('updateFailed'));
        return;
      }
      setItems((prev) => (prev ?? []).map((x) => (x.id === e.id ? (payload.webhook as Endpoint) : x)));
    } finally {
      setBusy(null);
    }
  }

  async function remove(e: Endpoint) {
    setBusy(e.id);
    try {
      const res = await fetch(`/api/account/webhooks/${e.id}`, { method: 'DELETE' });
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        toast.error(payload.error || t('whDeleteFailed'));
        return;
      }
      toast.success(t('whDeleted'));
      setItems((prev) => (prev ?? []).filter((x) => x.id !== e.id));
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card>
      <CardContent className="space-y-3 py-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-foreground text-sm font-medium">{t('whTitle')}</p>
            <p className="text-muted-foreground mt-0.5 text-xs">{t('whDesc')}</p>
          </div>
          <Button size="sm" variant="outline" onClick={() => setCreateOpen(true)}>
            <Plus className="size-4" />
            {t('whNew')}
          </Button>
        </div>

        {items === null ? (
          <Loader2 className="text-primary size-4 animate-spin" />
        ) : items.length === 0 ? (
          <p className="text-muted-foreground flex items-center gap-2 text-xs">
            <Webhook className="size-4" />
            {t('whEmpty')}
          </p>
        ) : (
          <ul className="divide-border divide-y">
            {items.map((e) => (
              <li key={e.id} className="space-y-2 py-2.5">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-4">
                  <div className="min-w-0 flex-1">
                    <p className={`truncate font-mono text-xs ${e.is_active ? 'text-foreground' : 'text-muted-foreground line-through'}`}>
                      {e.url}
                    </p>
                    <div className="mt-1 flex flex-wrap gap-1">
                      {e.events.map((ev) => (
                        <Badge key={ev} className="border-border bg-muted text-muted-foreground text-[10px]" title={WEBHOOK_EVENT_LABELS_PT[ev as WebhookEvent]}>
                          {ev}
                        </Badge>
                      ))}
                    </div>
                    <p className="text-muted-foreground mt-1 text-xs">
                      {e.last_delivery_at ? t('whLastOk', { date: fmtDateTime(e.last_delivery_at) }) : t('whNeverDelivered')}
                      {e.failure_count > 0 ? ` · ${t('whFailures', { count: e.failure_count })}` : ''}
                      {!e.is_active && e.failure_count > 0 ? ` · ${t('whAutoDisabled')}` : ''}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <label className="flex items-center gap-2 text-xs">
                      <Switch checked={e.is_active} disabled={busy === e.id} onCheckedChange={(v) => setActive(e, v)} />
                      {t('whActive')}
                    </label>
                    <Button variant="ghost" size="sm" onClick={() => setOpen(open === e.id ? null : e.id)}>
                      {open === e.id ? <ChevronUp className="size-4" /> : <ChevronDown className="size-4" />}
                      {t('whDeliveries')}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy === e.id}
                      onClick={() => remove(e)}
                      className="border-red-500/40 bg-red-500/10 text-red-300 hover:bg-red-500/20 hover:text-red-200"
                      aria-label={t('whDelete')}
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </div>
                </div>
                {open === e.id && (
                  <div className="border-border bg-muted/30 rounded-md border p-2.5">
                    <Deliveries endpointId={e.id} />
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
      <CreateWebhookDialog open={createOpen} onOpenChange={setCreateOpen} onCreated={load} />
    </Card>
  );
}

function CreateWebhookDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: () => void;
}) {
  const t = useTranslations('Settings.apiKeys');
  const [url, setUrl] = useState('');
  const [events, setEvents] = useState<WebhookEvent[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);

  function reset() {
    setUrl('');
    setEvents([]);
    setSubmitting(false);
    setSecret(null);
  }

  async function create() {
    setSubmitting(true);
    try {
      const res = await fetch('/api/account/webhooks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: url.trim(), events }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(payload.error || t('whCreateFailed'));
        return;
      }
      setSecret(payload.secret as string);
      onCreated();
    } catch {
      toast.error(t('networkError'));
    } finally {
      setSubmitting(false);
    }
  }

  async function copy() {
    if (!secret) return;
    try {
      await navigator.clipboard.writeText(secret);
      toast.success(t('copySuccess'));
    } catch {
      toast.error(t('copyFailed'));
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent className="border-border bg-popover sm:max-w-lg">
        {secret ? (
          <>
            <DialogHeader>
              <DialogTitle className="text-popover-foreground">{t('whSecretTitle')}</DialogTitle>
              <DialogDescription className="text-muted-foreground">{t('whSecretDesc')}</DialogDescription>
            </DialogHeader>
            <div className="flex gap-2">
              <Input readOnly value={secret} className="font-mono text-xs" onFocus={(e) => e.currentTarget.select()} />
              <Button type="button" variant="outline" onClick={copy}>
                <Copy className="size-4" />
                {t('copy')}
              </Button>
            </div>
            <DialogFooter>
              <Button
                onClick={() => {
                  reset();
                  onOpenChange(false);
                }}
              >
                {t('done')}
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle className="text-popover-foreground">{t('whNewTitle')}</DialogTitle>
              <DialogDescription className="text-muted-foreground">{t('whNewDesc')}</DialogDescription>
            </DialogHeader>
            <div className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="wh-url" className="text-muted-foreground">
                  {t('whUrlLabel')}
                </Label>
                <Input id="wh-url" value={url} placeholder="https://" onChange={(e) => setUrl(e.target.value)} />
              </div>
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label className="text-muted-foreground">{t('whEventsLabel')}</Label>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2 text-xs"
                    onClick={() => setEvents(events.length === WEBHOOK_EVENTS.length ? [] : [...WEBHOOK_EVENTS])}
                  >
                    {events.length === WEBHOOK_EVENTS.length ? t('presetNone') : t('whAllEvents')}
                  </Button>
                </div>
                <div className="border-border max-h-64 space-y-2 overflow-y-auto rounded-md border p-3">
                  {WEBHOOK_EVENTS.map((ev) => (
                    <label key={ev} className="flex cursor-pointer items-start gap-2.5">
                      <Checkbox
                        checked={events.includes(ev)}
                        onCheckedChange={(c) =>
                          setEvents((prev) => (c === true ? [...prev, ev] : prev.filter((x) => x !== ev)))
                        }
                        className="mt-0.5"
                      />
                      <span className="min-w-0">
                        <span className="text-foreground block font-mono text-xs">{ev}</span>
                        <span className="text-muted-foreground block text-xs">{WEBHOOK_EVENT_LABELS_PT[ev]}</span>
                      </span>
                    </label>
                  ))}
                </div>
              </div>
            </div>
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => {
                  reset();
                  onOpenChange(false);
                }}
              >
                {t('cancel')}
              </Button>
              <Button onClick={create} disabled={submitting || !url.trim() || events.length === 0}>
                {submitting ? <Loader2 className="size-4 animate-spin" /> : null}
                {t('whCreate')}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
