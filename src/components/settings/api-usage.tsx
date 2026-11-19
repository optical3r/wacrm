'use client';

// ============================================================
// ApiUsage — Settings → API e MCP → "Uso nos últimos 30 dias".
// Calls and errors per key / connected app and the latest errors,
// from /api/account/api-usage. admin+.
// ============================================================

import { useEffect, useState } from 'react';
import { Activity, Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';

interface Usage {
  total: number;
  errors: number;
  credentials: Array<{ name: string; kind: 'key' | 'app'; calls: number; errors: number; mcp_calls: number; last_at: string }>;
  recent_errors: Array<{ credential: string; via: string; method: string; route: string; status: number; created_at: string }>;
}

function fmtDateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

const nf = new Intl.NumberFormat();

export function ApiUsage() {
  const t = useTranslations('Settings.apiKeys');
  const [usage, setUsage] = useState<Usage | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    fetch('/api/account/api-usage', { cache: 'no-store' })
      .then(async (res) => {
        if (!res.ok) throw new Error(String(res.status));
        const data = (await res.json()) as Usage;
        if (alive) setUsage(data);
      })
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, []);

  return (
    <Card>
      <CardContent className="space-y-3 py-4">
        <div>
          <p className="text-foreground text-sm font-medium">{t('usageTitle')}</p>
          <p className="text-muted-foreground mt-0.5 text-xs">
            {usage ? t('usageTotals', { calls: nf.format(usage.total), errors: nf.format(usage.errors) }) : t('usageDesc')}
          </p>
        </div>
        {failed ? (
          <p className="text-muted-foreground text-xs">{t('usageLoadFailed')}</p>
        ) : !usage ? (
          <Loader2 className="text-primary size-4 animate-spin" />
        ) : usage.credentials.length === 0 ? (
          <p className="text-muted-foreground flex items-center gap-2 text-xs">
            <Activity className="size-4" />
            {t('usageEmpty')}
          </p>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="text-muted-foreground text-left">
                  <tr>
                    <th className="py-1.5 pr-3 font-normal">{t('usageColCredential')}</th>
                    <th className="py-1.5 pr-3 text-right font-normal">{t('usageColCalls')}</th>
                    <th className="py-1.5 pr-3 text-right font-normal">{t('usageColMcp')}</th>
                    <th className="py-1.5 pr-3 text-right font-normal">{t('usageColErrors')}</th>
                    <th className="py-1.5 font-normal">{t('usageColLast')}</th>
                  </tr>
                </thead>
                <tbody className="divide-border divide-y">
                  {usage.credentials.map((c, i) => (
                    <tr key={`${c.name}-${i}`}>
                      <td className="text-foreground py-1.5 pr-3">
                        {c.name}{' '}
                        {c.kind === 'app' && (
                          <Badge className="border-border bg-muted text-muted-foreground ml-1 text-[10px]">{t('usageApp')}</Badge>
                        )}
                      </td>
                      <td className="py-1.5 pr-3 text-right font-mono">{nf.format(c.calls)}</td>
                      <td className="text-muted-foreground py-1.5 pr-3 text-right font-mono">{nf.format(c.mcp_calls)}</td>
                      <td className={`py-1.5 pr-3 text-right font-mono ${c.errors ? 'text-red-400' : 'text-muted-foreground'}`}>
                        {nf.format(c.errors)}
                      </td>
                      <td className="text-muted-foreground py-1.5">{fmtDateTime(c.last_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {usage.recent_errors.length > 0 && (
              <div className="space-y-1.5">
                <p className="text-foreground text-xs font-medium">{t('usageRecentErrors')}</p>
                <ul className="space-y-1">
                  {usage.recent_errors.map((e, i) => (
                    <li key={i} className="text-muted-foreground flex flex-wrap gap-x-2 font-mono text-[11px]">
                      <span className="text-red-400">{e.status}</span>
                      <span className="text-foreground">
                        {e.via === 'mcp' ? 'MCP' : e.method} {e.route}
                      </span>
                      <span>{e.credential}</span>
                      <span>{fmtDateTime(e.created_at)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
