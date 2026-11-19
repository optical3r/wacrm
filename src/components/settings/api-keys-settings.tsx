'use client';

// ============================================================
// ApiKeysSettings — Settings → API keys
//
// Manage the credentials that authenticate the public REST API
// (`/api/v1/*`). Any member sees the roster (read-only); admin+ can
// mint and revoke (gated by <RequireRole min="admin"> here and the
// admin-only API routes + RLS on the server).
//
// One-time reveal: a freshly-minted key's plaintext is shown ONCE in
// the creation dialog. After it closes, only the prefix remains —
// the server stores just the hash. The UI states this explicitly so
// the absence of a "copy again" button reads as intentional, not a
// bug (same lesson as the invite-link flow).
// ============================================================

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Copy, KeyRound, Loader2, Plus, Trash2 } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { cn } from '@/lib/utils';
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
import { RequireRole } from '@/components/auth/require-role';
import { useAuth } from '@/hooks/use-auth';
import {
  API_AREAS,
  areaLevels,
  areasFromScopes,
  scopesFromAreas,
  type AreaLevel,
} from '@/lib/api-keys/scopes';
import { useTranslations } from 'next-intl';
import { SettingsPanelHead } from './settings-panel-head';
import { ConnectedApps } from './connected-apps';
import { ApiUsage } from './api-usage';
import { WebhooksSettings } from './webhooks-settings';

interface ApiKey {
  id: string;
  name: string;
  key_prefix: string;
  scopes: string[];
  mcp_enabled?: boolean;
  mcp_allow_writes?: boolean;
  last_used_at: string | null;
  expires_at: string | null;
  revoked_at: string | null;
  created_at: string;
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

/** The remote MCP endpoint of this deployment. */
function mcpUrl(): string {
  return typeof window === 'undefined' ? '/api/mcp' : `${window.location.origin}/api/mcp`;
}

function claudeCodeSnippet(key: string): string {
  return `claude mcp add --transport http labcrm ${mcpUrl()} --header "Authorization: Bearer ${key}"`;
}

function codexSnippet(): string {
  return `[mcp_servers.labcrm]\nurl = "${mcpUrl()}"\nbearer_token_env_var = "LABCRM_API_KEY"`;
}

function SnippetBlock({ label, value, hint }: { label: string; value: string; hint?: string }) {
  const t = useTranslations('Settings.apiKeys');
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      toast.success(t('snippetCopied'));
    } catch {
      toast.error(t('copyFailed'));
    }
  }
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <Label className="text-muted-foreground text-xs">{label}</Label>
        <Button type="button" variant="ghost" size="sm" onClick={copy} className="h-7 px-2">
          <Copy className="size-3.5" />
          {t('copy')}
        </Button>
      </div>
      <pre className="border-border bg-muted/50 overflow-x-auto rounded-md border p-2.5 font-mono text-[11px] leading-relaxed whitespace-pre">
        {value}
      </pre>
      {hint && <p className="text-muted-foreground text-xs">{hint}</p>}
    </div>
  );
}

/** The areas a key reaches, for the badges in the list. */
function keyAreas(scopes: string[]) {
  const levels = areasFromScopes(scopes);
  return API_AREAS.filter((a) => levels[a.id] !== 'none').map((a) => ({
    id: a.id,
    label: a.label,
    level: levels[a.id],
  }));
}

function keyStatus(k: ApiKey): 'active' | 'revoked' | 'expired' {
  if (k.revoked_at) return 'revoked';
  if (k.expires_at && new Date(k.expires_at).getTime() <= Date.now())
    return 'expired';
  return 'active';
}

export function ApiKeysSettings() {
  const { canEditSettings } = useAuth();
  const t = useTranslations('Settings.apiKeys');

  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [updating, setUpdating] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/account/api-keys', { cache: 'no-store' });
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        toast.error(payload.error || t('loadFailed'));
        return;
      }
      const data = (await res.json()) as { keys: ApiKey[] };
      setKeys(data.keys);
    } catch (err) {
      console.error('[ApiKeysSettings] load error:', err);
      toast.error(t('networkError'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleMcpChange(
    key: ApiKey,
    patch: { mcpEnabled?: boolean; mcpAllowWrites?: boolean }
  ) {
    setUpdating(key.id);
    try {
      const res = await fetch(`/api/account/api-keys/${key.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(payload.error || t('updateFailed'));
        return;
      }
      const updated = payload.key as Pick<ApiKey, 'id' | 'mcp_enabled' | 'mcp_allow_writes'>;
      setKeys((prev) => prev.map((k) => (k.id === key.id ? { ...k, ...updated } : k)));
      toast.success(t('updateSuccess'));
    } catch (err) {
      console.error('[ApiKeysSettings] update error:', err);
      toast.error(t('networkError'));
    } finally {
      setUpdating(null);
    }
  }

  async function handleRevoke(key: ApiKey) {
    setRevoking(key.id);
    try {
      const res = await fetch(`/api/account/api-keys/${key.id}`, {
        method: 'DELETE',
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        toast.error(payload.error || t('revokeFailed'));
        return;
      }
      toast.success(t('revokeSuccess', { name: key.name }));
      // Reflect the revoke locally without a refetch.
      setKeys((prev) =>
        prev.map((k) =>
          k.id === key.id ? { ...k, revoked_at: new Date().toISOString() } : k
        )
      );
    } catch (err) {
      console.error('[ApiKeysSettings] revoke error:', err);
      toast.error(t('networkError'));
    } finally {
      setRevoking(null);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="text-primary size-6 animate-spin" />
      </div>
    );
  }

  return (
    <section className="animate-in fade-in-50 space-y-6 duration-200">
      <SettingsPanelHead
        title={t('title')}
        description={
          t.rich('description', {
            apiCode: (chunks: React.ReactNode) => <code className="text-xs">{chunks}</code>,
            headerCode: (chunks: React.ReactNode) => <code className="text-xs">{chunks}</code>
          })
        }
        action={
          <RequireRole min="admin">
            <Button onClick={() => setCreateOpen(true)}>
              <Plus className="size-4" />
              {t('newApiKey')}
            </Button>
          </RequireRole>
        }
      />

      {keys.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-10 text-center">
            <KeyRound className="text-muted-foreground size-6" />
            <p className="text-muted-foreground mt-2 text-sm">
              {t('noApiKeys')}
            </p>
            {canEditSettings ? (
              <p className="text-muted-foreground mt-1 text-xs">
                {t.rich('createOneHint', {
                  bold: (chunks: React.ReactNode) => (
                    <span className="text-foreground">{chunks}</span>
                  ),
                })}
              </p>
            ) : (
              <p className="text-muted-foreground mt-1 text-xs">
                {t('askAdminHint')}
              </p>
            )}
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0">
            <ul className="divide-border divide-y">
              {keys.map((k) => {
                const status = keyStatus(k);
                const inactive = status !== 'active';
                return (
                  <li
                    key={k.id}
                    className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:gap-4"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span
                          className={`truncate text-sm font-medium ${
                            inactive
                              ? 'text-muted-foreground line-through'
                              : 'text-foreground'
                          }`}
                        >
                          {k.name}
                        </span>
                        {status === 'revoked' && (
                          <Badge className="border-border bg-muted text-muted-foreground text-[10px] tracking-wide uppercase">
                            {t('revoked')}
                          </Badge>
                        )}
                        {status === 'expired' && (
                          <Badge className="border-border bg-muted text-muted-foreground text-[10px] tracking-wide uppercase">
                            {t('expired')}
                          </Badge>
                        )}
                      </div>
                      <p className="text-muted-foreground mt-0.5 font-mono text-xs">
                        {k.key_prefix}…
                      </p>
                      <div className="mt-1.5 flex flex-wrap gap-1">
                        {k.scopes.length === 0 ? (
                          <span className="text-muted-foreground text-xs">
                            {t('noScopes')}
                          </span>
                        ) : (
                          keyAreas(k.scopes).map(({ id, label, level }) => (
                            <Badge
                              key={id}
                              title={k.scopes.join(' ')}
                              className="border-border bg-muted text-muted-foreground text-[10px]"
                            >
                              {label}: {level === 'write' ? t('levelWrite') : t('levelRead')}
                            </Badge>
                          ))
                        )}
                        {status === 'active' && (
                          <Badge className="border-primary/30 bg-primary/10 text-primary text-[10px]">
                            {k.mcp_enabled === false
                              ? t('badgeMcpOff')
                              : k.mcp_allow_writes
                                ? t('badgeMcpWrites')
                                : t('badgeMcp')}
                          </Badge>
                        )}
                      </div>
                      {status === 'active' && canEditSettings && (
                        <div className="mt-2 flex flex-wrap items-center gap-4">
                          <label className="flex items-center gap-2 text-xs">
                            <Switch
                              checked={k.mcp_enabled !== false}
                              disabled={updating === k.id}
                              onCheckedChange={(v) => handleMcpChange(k, { mcpEnabled: v })}
                            />
                            {t('toggleMcp')}
                          </label>
                          <label className="flex items-center gap-2 text-xs">
                            <Switch
                              checked={k.mcp_allow_writes === true}
                              disabled={updating === k.id || k.mcp_enabled === false}
                              onCheckedChange={(v) => handleMcpChange(k, { mcpAllowWrites: v })}
                            />
                            {t('toggleMcpWrites')}
                          </label>
                        </div>
                      )}
                      <p className="text-muted-foreground mt-1.5 text-xs">
                        {t('created', { date: fmtDate(k.created_at) })}
                        {' · '}
                        {k.last_used_at
                          ? t('lastUsed', { date: fmtDate(k.last_used_at) })
                          : t('neverUsed')}
                        {k.expires_at && status !== 'expired'
                          ? ` · ${t('expires', { date: fmtDate(k.expires_at) })}`
                          : ''}
                      </p>
                    </div>

                    {status === 'active' && (
                      <RequireRole min="admin">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => handleRevoke(k)}
                          disabled={revoking === k.id}
                          className="self-start border-red-500/40 bg-red-500/10 text-red-300 hover:border-red-500/60 hover:bg-red-500/20 hover:text-red-200 sm:self-auto"
                        >
                          {revoking === k.id ? (
                            <Loader2 className="size-4 animate-spin" />
                          ) : (
                            <Trash2 className="size-4" />
                          )}
                          {t('revoke')}
                        </Button>
                      </RequireRole>
                    )}
                  </li>
                );
              })}
            </ul>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent className="space-y-4 py-4">
          <div>
            <p className="text-foreground text-sm font-medium">{t('connectTitle')}</p>
            <p className="text-muted-foreground mt-0.5 text-xs">
              {t('connectDesc', { url: mcpUrl() })}
            </p>
          </div>
          <SnippetBlock label={t('claudeCodeLabel')} value={claudeCodeSnippet(t('yourKeyPlaceholder'))} />
          <SnippetBlock label={t('codexLabel')} value={codexSnippet()} hint={t('codexEnvHint')} />
          <SnippetBlock label={t('claudeAiLabel')} value={mcpUrl()} hint={t('claudeAiHint')} />
          <p className="text-muted-foreground text-xs">
            <a href="/docs/api" target="_blank" rel="noreferrer" className="text-primary hover:text-primary/80">
              {t('docsLink')}
            </a>
            {' · '}
            {t('docsHint')}
          </p>
        </CardContent>
      </Card>

      {canEditSettings && (
        <>
          <ConnectedApps />
          <ApiUsage />
          <WebhooksSettings />
        </>
      )}

      <CreateKeyDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={load}
      />
    </section>
  );
}

// ------------------------------------------------------------
// Create dialog — form → one-time plaintext reveal.
// ------------------------------------------------------------

function CreateKeyDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: () => void;
}) {
  const t = useTranslations('Settings.apiKeys');
  const [name, setName] = useState('');
  const { account } = useAuth();
  const plan = account?.plan === 'starter' ? 'starter' : 'pro';
  const areas = API_AREAS.filter((a) => !a.plan || a.plan === plan);
  const [levels, setLevels] = useState<Record<string, AreaLevel>>({});
  const [mcpEnabled, setMcpEnabled] = useState(true);
  const [mcpAllowWrites, setMcpAllowWrites] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  // Once set, we switch from the form to the reveal view.
  const [createdKey, setCreatedKey] = useState<string | null>(null);

  function reset() {
    setName('');
    setLevels({});
    setMcpEnabled(true);
    setMcpAllowWrites(false);
    setSubmitting(false);
    setCreatedKey(null);
  }

  function setAll(level: AreaLevel) {
    const next: Record<string, AreaLevel> = {};
    for (const a of areas) {
      const offered = areaLevels(a);
      next[a.id] = offered.includes(level) ? level : level === 'none' ? 'none' : offered[offered.length - 1];
      // "Tudo leitura" leaves write-only areas (webhooks) off.
      if (level === 'read' && !a.read.length) next[a.id] = 'none';
    }
    setLevels(next);
  }

  async function handleCreate() {
    const trimmed = name.trim();
    if (!trimmed) {
      toast.error(t('nameRequired'));
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch('/api/account/api-keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: trimmed, scopes: scopesFromAreas(levels), mcpEnabled, mcpAllowWrites }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(payload.error || t('createError'));
        return;
      }
      setCreatedKey(payload.plaintext as string);
      onCreated();
    } catch (err) {
      console.error('[CreateKeyDialog] create error:', err);
      toast.error(t('networkError'));
    } finally {
      setSubmitting(false);
    }
  }

  async function copyKey() {
    if (!createdKey) return;
    try {
      await navigator.clipboard.writeText(createdKey);
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
        {createdKey ? (
          <>
            <DialogHeader>
              <DialogTitle className="text-popover-foreground">
                {t('copyTitle')}
              </DialogTitle>
              <DialogDescription className="text-muted-foreground">
                {t('copyDesc')}
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-1.5">
              <Label className="text-muted-foreground">{t('apiKeyLabel')}</Label>
              <div className="flex gap-2">
                <Input
                  readOnly
                  value={createdKey}
                  className="font-mono text-xs"
                  onFocus={(e) => e.currentTarget.select()}
                />
                <Button type="button" variant="outline" onClick={copyKey}>
                  <Copy className="size-4" />
                  {t('copy')}
                </Button>
              </div>
            </div>

            {mcpEnabled && (
              <div className="space-y-3">
                <p className="text-foreground text-sm font-medium">{t('connectTitle')}</p>
                <SnippetBlock label={t('claudeCodeLabel')} value={claudeCodeSnippet(createdKey)} />
                <SnippetBlock
                  label={t('codexLabel')}
                  value={codexSnippet()}
                  hint={t('codexEnvHint')}
                />
              </div>
            )}

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
              <DialogTitle className="text-popover-foreground">
                {t('newKeyTitle')}
              </DialogTitle>
              <DialogDescription className="text-muted-foreground">
                {t('newKeyDesc')}
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="api-key-name" className="text-muted-foreground">
                  {t('nameLabel')}
                </Label>
                <Input
                  id="api-key-name"
                  value={name}
                  maxLength={80}
                  placeholder={t('namePlaceholder')}
                  onChange={(e) => setName(e.target.value)}
                />
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <Label className="text-muted-foreground">{t('areasLabel')}</Label>
                  <div className="flex gap-1">
                    <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => setAll('read')}>
                      {t('presetRead')}
                    </Button>
                    <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => setAll('write')}>
                      {t('presetAll')}
                    </Button>
                    <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => setAll('none')}>
                      {t('presetNone')}
                    </Button>
                  </div>
                </div>
                <div className="border-border divide-border max-h-72 divide-y overflow-y-auto rounded-md border">
                  {areas.map((area) => {
                    const current = levels[area.id] ?? 'none';
                    return (
                      <div key={area.id} className="flex items-center justify-between gap-3 px-3 py-2">
                        <span className="text-foreground text-xs" title={[...area.read, ...area.write].join(' ')}>
                          {area.label}
                        </span>
                        <div className="border-border flex shrink-0 overflow-hidden rounded-md border text-[11px]">
                          {areaLevels(area).map((level) => (
                            <button
                              key={level}
                              type="button"
                              aria-pressed={current === level}
                              onClick={() => setLevels((prev) => ({ ...prev, [area.id]: level }))}
                              className={cn(
                                'px-2.5 py-1 transition-colors',
                                current === level
                                  ? 'bg-primary text-primary-foreground'
                                  : 'text-muted-foreground hover:bg-muted'
                              )}
                            >
                              {level === 'none' ? t('levelNone') : level === 'read' ? t('levelRead') : t('levelWrite')}
                            </button>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>
                <p className="text-muted-foreground text-xs">{t('areasHint')}</p>
              </div>

              <div className="border-border space-y-3 rounded-md border p-3">
                <label className="flex cursor-pointer items-start gap-2.5">
                  <Checkbox
                    checked={mcpEnabled}
                    onCheckedChange={(checked) => {
                      setMcpEnabled(checked === true);
                      if (checked !== true) setMcpAllowWrites(false);
                    }}
                    className="mt-0.5"
                  />
                  <span className="min-w-0">
                    <span className="text-foreground block text-xs font-medium">{t('mcpLabel')}</span>
                    <span className="text-muted-foreground block text-xs">{t('mcpHint')}</span>
                  </span>
                </label>
                <label className="flex cursor-pointer items-start gap-2.5">
                  <Checkbox
                    checked={mcpAllowWrites}
                    disabled={!mcpEnabled}
                    onCheckedChange={(checked) => setMcpAllowWrites(checked === true)}
                    className="mt-0.5"
                  />
                  <span className="min-w-0">
                    <span className="text-foreground block text-xs font-medium">
                      {t('mcpWritesLabel')}
                    </span>
                    <span className="text-muted-foreground block text-xs">{t('mcpWritesHint')}</span>
                  </span>
                </label>
              </div>
            </div>

            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => {
                  reset();
                  onOpenChange(false);
                }}
                className="border-border text-muted-foreground hover:bg-muted"
              >
                {t('cancel')}
              </Button>
              <Button onClick={handleCreate} disabled={submitting}>
                {submitting ? (
                  <>
                    <Loader2 className="size-4 animate-spin" />
                    {t('creating')}
                  </>
                ) : (
                  t('createKey')
                )}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
