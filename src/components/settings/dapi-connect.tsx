'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
import { AlertTriangle, CheckCircle2, Loader2, QrCode, RefreshCw, Smartphone } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

type SessionStatus = 'connecting' | 'connected' | 'disconnected' | 'qr_ready' | 'pair_code_ready';

export interface DapiNumber {
  id: string;
  label: string | null;
  status: 'connected' | 'disconnected';
  is_default: boolean;
  phone: string | null;
  owner_user_id: string | null;
  owner_name: string | null;
  mine: boolean;
  connected_at: string | null;
}

export interface DapiMember {
  user_id: string;
  name: string;
  role: string;
}

export interface DapiState {
  enabled: boolean;
  configured?: boolean;
  /** Agent and up connect their own number; owner / admin manage all. */
  can_connect?: boolean;
  can_manage?: boolean;
  max_numbers?: number;
  numbers?: DapiNumber[];
  /** Owner / admin: who can own a number (agent and up). */
  members?: DapiMember[];
  /** Whose session `session` describes. */
  target_user_id?: string;
  session: {
    status: SessionStatus;
    phone?: string | null;
    qr_image?: string | null;
    pair_code?: string | null;
  } | null;
  sync_error?: string | null;
}

const POLL_MS = 3000;
const POLL_LIMIT_MS = 5 * 60 * 1000;
/** A brand-new session can report "disconnected" while it boots. */
const START_GRACE_MS = 90 * 1000;

/**
 * Starter plan: connect the member's own WhatsApp number by scanning a
 * QR code (or typing a pairing code), through D-API. Each member has
 * their own number (up to the account's limit). Owner / admin can also
 * connect a number on behalf of a member, picking who it is linked to.
 * The risk notice comes first — unofficial connections can get a number
 * banned.
 */
export function DapiConnect({
  initial,
  canEdit,
  limitReached = false,
  onConnected,
}: {
  initial: DapiState;
  canEdit: boolean;
  /** The account has no free number slot for this member. */
  limitReached?: boolean;
  /** Gets the latest state, so a remount (the parent reloads) starts from it. */
  onConnected: (state: DapiState) => void;
}) {
  const t = useTranslations('Settings.dapi');
  const [state, setState] = useState<DapiState>(initial);
  const [accepted, setAccepted] = useState(false);
  const [mode, setMode] = useState<'qr' | 'pair'>('qr');
  const [phone, setPhone] = useState('');
  const [busy, setBusy] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollStarted = useRef(0);
  const polling = useRef(false);
  // Whose number this card connects: the caller, or the member an owner /
  // admin picked. A ref too, so the poll loop always asks about the
  // current pick.
  const [target, setTarget] = useState<string | null>(initial.target_user_id ?? null);
  const targetRef = useRef<string | null>(target);
  const members = state.can_manage ? state.members ?? [] : [];
  const self = initial.target_user_id ?? null;
  const forQuery = (id: string | null) => (id && id !== self ? `?for=${encodeURIComponent(id)}` : '');
  const numbers = state.numbers ?? [];
  const targetHasNumber = numbers.some((n) => n.owner_user_id === target);
  const noSlot = state.can_manage
    ? !targetHasNumber && numbers.length >= (state.max_numbers ?? 5)
    : limitReached;

  const status = state.session?.status ?? null;
  const connected = status === 'connected' && !state.sync_error;
  // While polling, keep the pairing panel up even if D-API briefly reports
  // the new session as disconnected (it is still starting).
  const pairing =
    status !== 'connected' &&
    (waiting || status === 'connecting' || status === 'qr_ready' || status === 'pair_code_ready');

  const refresh = useCallback(async (): Promise<DapiState | null> => {
    try {
      const res = await fetch(`/api/whatsapp/dapi${forQuery(targetRef.current)}`, { cache: 'no-store' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setState(data);
      return data;
    } catch (err) {
      console.error('[dapi] status check failed:', err);
      return null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const stopPolling = useCallback(() => {
    polling.current = false;
    if (pollTimer.current) clearTimeout(pollTimer.current);
    pollTimer.current = null;
    setWaiting(false);
  }, []);

  const poll = useCallback(async () => {
    if (!polling.current) return;
    const data = await refresh();
    if (!polling.current) return;
    if (data?.session?.status === 'connected') {
      stopPolling();
      if (data.sync_error) toast.error(data.sync_error);
      else {
        toast.success(t('connectedToast'));
        onConnected(data);
      }
      return;
    }
    if (data && data.session === null) {
      // The session no longer exists on D-API: show the connect form again.
      stopPolling();
      toast.error(t('sessionLost'));
      return;
    }
    const elapsed = Date.now() - pollStarted.current;
    if ((data?.session?.status === 'disconnected' && elapsed > START_GRACE_MS) || elapsed > POLL_LIMIT_MS) {
      stopPolling();
      return;
    }
    pollTimer.current = setTimeout(poll, POLL_MS);
  }, [refresh, stopPolling, onConnected, t]);

  const startPolling = useCallback(() => {
    if (pollTimer.current) clearTimeout(pollTimer.current);
    polling.current = true;
    pollStarted.current = Date.now();
    setWaiting(true);
    pollTimer.current = setTimeout(poll, 1000);
  }, [poll]);

  // Resume polling when the page opens mid-pairing.
  useEffect(() => {
    const s = initial.session?.status;
    if (canEdit && (s === 'connecting' || s === 'qr_ready' || s === 'pair_code_ready')) startPolling();
    return () => {
      polling.current = false;
      if (pollTimer.current) clearTimeout(pollTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleConnect() {
    setBusy(true);
    try {
      const res = await fetch('/api/whatsapp/dapi', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode,
          phone: mode === 'pair' ? phone : undefined,
          accept_risk: accepted,
          for_user_id: target && target !== self ? target : undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setState((prev) => ({ ...prev, session: data.session, sync_error: data.sync_error }));
      if (data.session?.status === 'connected') {
        if (!data.sync_error) onConnected({ ...state, session: data.session, sync_error: null });
        return;
      }
      startPolling();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('connectFailed'));
    } finally {
      setBusy(false);
    }
  }

  async function handleDisconnect() {
    if (!window.confirm(t('disconnectConfirm'))) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/whatsapp/dapi${forQuery(target)}`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      stopPolling();
      const next: DapiState = { ...state, session: { status: 'disconnected' }, sync_error: null };
      setState(next);
      toast.success(t('disconnectedToast'));
      onConnected(next);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('disconnectFailed'));
    } finally {
      setBusy(false);
    }
  }

  async function pickTarget(id: string) {
    stopPolling();
    setTarget(id);
    targetRef.current = id;
    setAccepted(false);
    setState((prev) => ({ ...prev, session: null, sync_error: null }));
    setBusy(true);
    const data = await refresh();
    setBusy(false);
    const s = data?.session?.status;
    if (s === 'connecting' || s === 'qr_ready' || s === 'pair_code_ready') startPolling();
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-foreground">
          <QrCode className="size-5 text-primary" />
          {members.length > 0 ? t('titleManage') : t('title')}
        </CardTitle>
        <CardDescription className="text-muted-foreground">{t('description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {members.length > 0 && canEdit && (
          <div className="space-y-1.5">
            <Label htmlFor="dapi-owner">{t('linkTo')}</Label>
            <select
              id="dapi-owner"
              value={target ?? ''}
              disabled={busy}
              onChange={(e) => void pickTarget(e.target.value)}
              className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground"
            >
              {members.map((m) => {
                const has = numbers.some((n) => n.owner_user_id === m.user_id);
                const name = m.user_id === self ? t('memberYou', { name: m.name }) : m.name;
                return (
                  <option key={m.user_id} value={m.user_id}>
                    {has ? `${name} · ${t('hasNumber')}` : name}
                  </option>
                );
              })}
            </select>
            <p className="text-xs text-muted-foreground">{t('linkToHint')}</p>
          </div>
        )}

        {state.configured === false && (
          <Alert>
            <AlertTriangle className="size-4" />
            <AlertTitle>{t('notConfiguredTitle')}</AlertTitle>
            <AlertDescription>{t('notConfiguredDesc')}</AlertDescription>
          </Alert>
        )}

        {connected && (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-primary/40 bg-primary-soft p-4">
            <div className="flex items-center gap-3">
              <CheckCircle2 className="size-5 shrink-0 text-primary" />
              <div>
                <p className="text-sm font-medium text-foreground">{t('connected')}</p>
                {state.session?.phone && (
                  <p className="font-mono text-sm text-muted-foreground">+{state.session.phone}</p>
                )}
              </div>
            </div>
            {canEdit && (
              <Button variant="outline" onClick={handleDisconnect} disabled={busy}>
                {busy && <Loader2 className="mr-2 size-4 animate-spin" />}
                {t('disconnect')}
              </Button>
            )}
          </div>
        )}

        {status === 'connected' && state.sync_error && (
          <Alert>
            <AlertTriangle className="size-4" />
            <AlertDescription>{state.sync_error}</AlertDescription>
          </Alert>
        )}

        {status === 'disconnected' && (
          <Alert>
            <AlertTriangle className="size-4" />
            <AlertTitle>{t('disconnectedTitle')}</AlertTitle>
            <AlertDescription>{t('disconnectedDesc')}</AlertDescription>
          </Alert>
        )}

        {canEdit && pairing && (
          <div className="space-y-3 rounded-lg border border-border p-4">
            {state.session?.qr_image ? (
              <div className="flex flex-col items-center gap-3">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={state.session.qr_image}
                  alt={t('qrAlt')}
                  className="size-56 rounded-md bg-white p-2"
                />
                <p className="text-center text-sm text-muted-foreground">{t('qrSteps')}</p>
              </div>
            ) : state.session?.pair_code ? (
              <div className="flex flex-col items-center gap-3">
                <p className="font-mono text-3xl font-semibold tracking-[0.3em] text-foreground">
                  {state.session.pair_code}
                </p>
                <p className="text-center text-sm text-muted-foreground">{t('pairSteps')}</p>
              </div>
            ) : (
              <div className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" />
                {t('preparing')}
              </div>
            )}
            <div className="flex justify-center">
              <Button variant="outline" size="sm" onClick={() => (waiting ? undefined : startPolling())} disabled={waiting}>
                {waiting ? <Loader2 className="mr-2 size-4 animate-spin" /> : <RefreshCw className="mr-2 size-4" />}
                {waiting ? t('waiting') : t('checkAgain')}
              </Button>
            </div>
          </div>
        )}

        {!connected && !pairing && canEdit && noSlot && (
          <Alert>
            <AlertTriangle className="size-4" />
            <AlertTitle>{t('limitTitle')}</AlertTitle>
            <AlertDescription>{t('limitDesc', { max: state.max_numbers ?? 5 })}</AlertDescription>
          </Alert>
        )}

        {!connected && !pairing && canEdit && !noSlot && (
          <div className="space-y-4">
            <Alert>
              <AlertTriangle className="size-4" />
              <AlertTitle>{t('riskTitle')}</AlertTitle>
              <AlertDescription>{t('riskDesc')}</AlertDescription>
            </Alert>
            <label className="flex items-start gap-2 text-sm text-foreground">
              <Checkbox
                checked={accepted}
                onCheckedChange={(v) => setAccepted(v === true)}
                className="mt-0.5"
              />
              <span>{t('riskAccept')}</span>
            </label>

            <div className="flex flex-wrap gap-2">
              <Button variant={mode === 'qr' ? 'default' : 'outline'} size="sm" onClick={() => setMode('qr')}>
                <QrCode className="mr-2 size-4" />
                {t('modeQr')}
              </Button>
              <Button variant={mode === 'pair' ? 'default' : 'outline'} size="sm" onClick={() => setMode('pair')}>
                <Smartphone className="mr-2 size-4" />
                {t('modePair')}
              </Button>
            </div>

            {mode === 'pair' && (
              <div className="space-y-1.5">
                <Label htmlFor="dapi-phone">{t('phoneLabel')}</Label>
                <Input
                  id="dapi-phone"
                  inputMode="numeric"
                  placeholder="5571999999999"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                />
              </div>
            )}

            <Button onClick={handleConnect} disabled={busy || !accepted || state.configured === false}>
              {busy && <Loader2 className="mr-2 size-4 animate-spin" />}
              {status === 'disconnected' ? t('reconnect') : t('connect')}
            </Button>
          </div>
        )}

        {!connected && !canEdit && <p className="text-sm text-muted-foreground">{t('adminOnly')}</p>}
      </CardContent>
    </Card>
  );
}
