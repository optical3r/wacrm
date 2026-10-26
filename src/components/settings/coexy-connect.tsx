'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
import { AlertTriangle, CheckCircle2, Loader2, MessageCircle, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';

type ChannelStatus = 'pending' | 'active' | 'disconnected' | 'suspended';

export interface CoexyState {
  enabled: boolean;
  configured?: boolean;
  channel: {
    status: ChannelStatus;
    display_phone_number: string | null;
    connect_url: string | null;
  } | null;
  sync_error?: string | null;
}

const POLL_MS = 5000;
const POLL_LIMIT_MS = 15 * 60 * 1000;

/**
 * "Conectar" flow for installs running WHATSAPP_PROVIDER=coexy: one
 * button creates the account's Coexy channel and opens Meta's Embedded
 * Signup; this card then polls until the number is active, and the
 * server saves the credentials on its own.
 */
export function CoexyConnect({
  initial,
  canEdit,
  onConnected,
}: {
  initial: CoexyState;
  canEdit: boolean;
  onConnected: () => void;
}) {
  const t = useTranslations('Settings.coexy');
  const [state, setState] = useState<CoexyState>(initial);
  const [connecting, setConnecting] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollStarted = useRef(0);

  const status = state.channel?.status ?? null;
  const connected = status === 'active' && !state.sync_error;

  const refresh = useCallback(async (): Promise<CoexyState | null> => {
    try {
      const res = await fetch('/api/whatsapp/coexy', { cache: 'no-store' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setState(data);
      return data;
    } catch (err) {
      console.error('[coexy] status check failed:', err);
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
    if (data?.channel?.status === 'active') {
      stopPolling();
      if (data.sync_error) {
        toast.error(data.sync_error);
      } else {
        toast.success(t('connectedToast'));
        onConnected();
      }
      return;
    }
    if (Date.now() - pollStarted.current > POLL_LIMIT_MS) {
      stopPolling();
      return;
    }
    pollTimer.current = setTimeout(poll, POLL_MS);
  }, [refresh, stopPolling, onConnected, t]);

  const startPolling = useCallback(() => {
    if (pollTimer.current) clearTimeout(pollTimer.current);
    pollStarted.current = Date.now();
    setWaiting(true);
    pollTimer.current = setTimeout(poll, POLL_MS);
  }, [poll]);

  useEffect(() => () => {
    if (pollTimer.current) clearTimeout(pollTimer.current);
  }, []);

  async function handleConnect() {
    // Open the tab inside the click so the popup blocker allows it,
    // then point it at Coexy once the channel exists.
    const popup = window.open('about:blank', '_blank');
    setConnecting(true);
    try {
      const res = await fetch('/api/whatsapp/coexy', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setState((prev) => ({ ...prev, channel: data.channel, sync_error: data.sync_error }));

      if (data.channel?.status === 'active') {
        popup?.close();
        if (!data.sync_error) onConnected();
        return;
      }
      const url: string | null = data.channel?.connect_url ?? null;
      if (!url) throw new Error(t('noConnectUrl'));
      if (popup) popup.location.href = url;
      else window.location.href = url;
      startPolling();
    } catch (err) {
      popup?.close();
      toast.error(err instanceof Error ? err.message : t('connectFailed'));
    } finally {
      setConnecting(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-foreground">
          <MessageCircle className="size-5 text-primary" />
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
          <div className="flex items-center gap-3 rounded-lg border border-primary/40 bg-primary-soft p-4">
            <CheckCircle2 className="size-5 shrink-0 text-primary" />
            <div>
              <p className="text-sm font-medium text-foreground">{t('connected')}</p>
              {state.channel?.display_phone_number && (
                <p className="font-mono text-sm text-muted-foreground">
                  {state.channel.display_phone_number}
                </p>
              )}
            </div>
          </div>
        )}

        {status === 'active' && state.sync_error && (
          <Alert>
            <AlertTriangle className="size-4" />
            <AlertDescription>{state.sync_error}</AlertDescription>
          </Alert>
        )}

        {(status === 'disconnected' || status === 'suspended') && (
          <Alert>
            <AlertTriangle className="size-4" />
            <AlertTitle>{status === 'suspended' ? t('suspendedTitle') : t('disconnectedTitle')}</AlertTitle>
            <AlertDescription>
              {status === 'suspended' ? t('suspendedDesc') : t('disconnectedDesc')}
            </AlertDescription>
          </Alert>
        )}

        {waiting && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            {t('waiting')}
          </div>
        )}

        {!connected && canEdit && status !== 'suspended' && (
          <div className="flex flex-wrap gap-2">
            <Button onClick={handleConnect} disabled={connecting || state.configured === false}>
              {connecting && <Loader2 className="mr-2 size-4 animate-spin" />}
              {status === 'disconnected' ? t('reconnect') : status === 'pending' ? t('continue') : t('connect')}
            </Button>
            {status && (
              <Button variant="outline" onClick={() => (waiting ? undefined : startPolling())} disabled={waiting}>
                <RefreshCw className="mr-2 size-4" />
                {t('checkAgain')}
              </Button>
            )}
          </div>
        )}

        {!connected && !canEdit && (
          <p className="text-sm text-muted-foreground">{t('adminOnly')}</p>
        )}

        {!connected && <p className="text-xs leading-relaxed text-muted-foreground">{t('howItWorks')}</p>}
      </CardContent>
    </Card>
  );
}
