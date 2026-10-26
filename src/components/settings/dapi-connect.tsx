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

export interface DapiState {
  enabled: boolean;
  configured?: boolean;
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
 * Starter plan: connect a WhatsApp number by scanning a QR code (or
 * typing a pairing code), through D-API. The admin first accepts the
 * risk notice — unofficial connections can get a number banned.
 */
export function DapiConnect({
  initial,
  canEdit,
  onConnected,
}: {
  initial: DapiState;
  canEdit: boolean;
  onConnected: () => void;
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

  const status = state.session?.status ?? null;
  const connected = status === 'connected' && !state.sync_error;
  // While polling, keep the pairing panel up even if D-API briefly reports
  // the new session as disconnected (it is still starting).
  const pairing = waiting || status === 'connecting' || status === 'qr_ready' || status === 'pair_code_ready';

  const refresh = useCallback(async (): Promise<DapiState | null> => {
    try {
      const res = await fetch('/api/whatsapp/dapi', { cache: 'no-store' });
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
    if (pollTimer.current) clearTimeout(pollTimer.current);
    pollTimer.current = null;
    setWaiting(false);
  }, []);

  const poll = useCallback(async () => {
    const data = await refresh();
    if (data?.session?.status === 'connected') {
      stopPolling();
      if (data.sync_error) toast.error(data.sync_error);
      else {
        toast.success(t('connectedToast'));
        onConnected();
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
    pollStarted.current = Date.now();
    setWaiting(true);
    pollTimer.current = setTimeout(poll, 1000);
  }, [poll]);

  // Resume polling when the page opens mid-pairing.
  useEffect(() => {
    const s = initial.session?.status;
    if (canEdit && (s === 'connecting' || s === 'qr_ready' || s === 'pair_code_ready')) startPolling();
    return () => {
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
        body: JSON.stringify({ mode, phone: mode === 'pair' ? phone : undefined, accept_risk: accepted }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setState((prev) => ({ ...prev, session: data.session, sync_error: data.sync_error }));
      if (data.session?.status === 'connected') {
        if (!data.sync_error) onConnected();
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
      const res = await fetch('/api/whatsapp/dapi', { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      stopPolling();
      setState((prev) => ({ ...prev, session: { status: 'disconnected' }, sync_error: null }));
      toast.success(t('disconnectedToast'));
      onConnected();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('disconnectFailed'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-foreground">
          <QrCode className="size-5 text-primary" />
          {t('title')}
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

        {!connected && !pairing && canEdit && (
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
