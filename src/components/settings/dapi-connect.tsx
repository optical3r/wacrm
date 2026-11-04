'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
import { AlertTriangle, Loader2, QrCode, RefreshCw, Smartphone, X } from 'lucide-react';
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
  /** Attendants linked to the number (migration 056). */
  member_ids: string[];
  member_names: string[];
  /** The caller is linked to it. */
  mine: boolean;
  connected_at: string | null;
  /** Reads WhatsApp groups (migration 052). */
  read_groups?: boolean;
  /** Messages sent from the inbox start with the attendant's name. */
  sign_messages?: boolean;
}

export interface DapiMember {
  user_id: string;
  name: string;
  role: string;
}

export interface DapiState {
  enabled: boolean;
  configured?: boolean;
  /** Owner / admin: connect and manage the company's numbers. */
  can_connect?: boolean;
  can_manage?: boolean;
  max_numbers?: number;
  numbers?: DapiNumber[];
  /** Owner / admin: who can be linked to a number (agent and up). */
  members?: DapiMember[];
  /** The pairing `session` describes, and the number it reconnects. */
  session_id?: string | null;
  channel_id?: string | null;
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
 * Starter plan, owner / admin: connect a company WhatsApp number by
 * scanning a QR code (or typing a pairing code), through D-API, or
 * reconnect one that dropped. Attendants are linked to numbers in the
 * list below. The risk notice comes first — unofficial connections can
 * get a number banned.
 */
export function DapiConnect({
  initial,
  reconnect = null,
  onConnected,
  onCancelReconnect,
}: {
  initial: DapiState;
  /** Reconnect this number instead of adding a new one. */
  reconnect?: { id: string; name: string } | null;
  /** Gets the latest state, so a remount (the parent reloads) starts from it. */
  onConnected: (state: DapiState) => void;
  onCancelReconnect?: () => void;
}) {
  const t = useTranslations('Settings.dapi');
  // A pairing already running for another number is not this card's.
  const resumable = !initial.session_id || (initial.channel_id ?? null) === (reconnect?.id ?? null);
  const [state, setState] = useState<DapiState>(
    resumable ? initial : { ...initial, session: null, session_id: null, sync_error: null },
  );
  const [accepted, setAccepted] = useState(false);
  const [mode, setMode] = useState<'qr' | 'pair'>('qr');
  const [phone, setPhone] = useState('');
  const [busy, setBusy] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollStarted = useRef(0);
  const polling = useRef(false);
  // The pairing being watched: a ref, so the poll loop always asks about it.
  const sessionRef = useRef<string | null>(resumable ? initial.session_id ?? null : null);
  const numbers = state.numbers ?? [];
  const noSlot = !reconnect && numbers.length >= (state.max_numbers ?? 5);

  const status = state.session?.status ?? null;
  // While polling, keep the pairing panel up even if D-API briefly reports
  // the new session as disconnected (it is still starting).
  const pairing =
    status !== 'connected' &&
    (waiting || status === 'connecting' || status === 'qr_ready' || status === 'pair_code_ready');

  const refresh = useCallback(async (): Promise<DapiState | null> => {
    const id = sessionRef.current;
    if (!id) return null;
    try {
      const res = await fetch(`/api/whatsapp/dapi?session=${encodeURIComponent(id)}`, { cache: 'no-store' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setState(data);
      return data;
    } catch (err) {
      console.error('[dapi] status check failed:', err);
      return null;
    }
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
        sessionRef.current = null;
        setAccepted(false);
        const next = { ...data, session: null, session_id: null, channel_id: null };
        setState(next);
        onConnected(next);
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
    const s = state.session?.status;
    if (sessionRef.current && (s === 'connecting' || s === 'qr_ready' || s === 'pair_code_ready')) startPolling();
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
          channel_id: reconnect?.id,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      sessionRef.current = data.session_id ?? null;
      setState((prev) => ({ ...prev, session: data.session, session_id: data.session_id, sync_error: null }));
      startPolling();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('connectFailed'));
    } finally {
      setBusy(false);
    }
  }

  async function handleCancel() {
    const id = sessionRef.current;
    stopPolling();
    sessionRef.current = null;
    setState((prev) => ({ ...prev, session: null, session_id: null, sync_error: null }));
    if (id) {
      await fetch(`/api/whatsapp/dapi?session=${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => undefined);
    }
    if (reconnect) onCancelReconnect?.();
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-foreground">
          <QrCode className="size-5 text-primary" />
          {reconnect ? t('reconnectTitle', { name: reconnect.name }) : t('titleManage')}
        </CardTitle>
        <CardDescription className="text-muted-foreground">{t('description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {state.configured === false && (
          <Alert>
            <AlertTriangle className="size-4" />
            <AlertTitle>{t('notConfiguredTitle')}</AlertTitle>
            <AlertDescription>{t('notConfiguredDesc')}</AlertDescription>
          </Alert>
        )}

        {status === 'connected' && state.sync_error && (
          <Alert>
            <AlertTriangle className="size-4" />
            <AlertDescription>{state.sync_error}</AlertDescription>
          </Alert>
        )}

        {status === 'disconnected' && !pairing && (
          <Alert>
            <AlertTriangle className="size-4" />
            <AlertTitle>{t('disconnectedTitle')}</AlertTitle>
            <AlertDescription>{t('disconnectedDesc')}</AlertDescription>
          </Alert>
        )}

        {pairing && (
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
            <div className="flex flex-wrap justify-center gap-2">
              <Button variant="outline" size="sm" onClick={() => (waiting ? undefined : startPolling())} disabled={waiting}>
                {waiting ? <Loader2 className="mr-2 size-4 animate-spin" /> : <RefreshCw className="mr-2 size-4" />}
                {waiting ? t('waiting') : t('checkAgain')}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => void handleCancel()}>
                <X className="mr-2 size-4" />
                {t('cancel')}
              </Button>
            </div>
          </div>
        )}

        {!pairing && noSlot && (
          <Alert>
            <AlertTriangle className="size-4" />
            <AlertTitle>{t('limitTitle')}</AlertTitle>
            <AlertDescription>{t('limitDesc', { max: state.max_numbers ?? 5 })}</AlertDescription>
          </Alert>
        )}

        {!pairing && !noSlot && (
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

            <div className="flex flex-wrap gap-2">
              <Button onClick={handleConnect} disabled={busy || !accepted || state.configured === false}>
                {busy && <Loader2 className="mr-2 size-4 animate-spin" />}
                {reconnect ? t('reconnect') : t('connect')}
              </Button>
              {reconnect && (
                <Button variant="ghost" onClick={() => onCancelReconnect?.()}>
                  {t('cancel')}
                </Button>
              )}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
