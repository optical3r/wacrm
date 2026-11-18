// ============================================================
// LabCRM MCP tools — each one is a thin adapter over a public-API
// route (src/app/api/v1). A tool builds the same request the
// endpoint would receive and calls the route's `run` with the
// caller's already-authenticated, account-scoped context, so a tool
// and its endpoint share validation, isolation and serialization.
//
// Access rules (approved plan, decision 3):
//   - the key must have "Usar no MCP" on (checked by the endpoint);
//   - read tools need only the route's scope;
//   - write tools also need "Permitir escrita pelo MCP" on the key;
//   - destructive or outward actions (sending, deleting) also need
//     `confirmar: true` in the call.
// ============================================================

import { z } from 'zod';

import type { ApiRouteHandler } from '@/lib/auth/api-context';
import * as contacts from '@/app/api/v1/contacts/route';
import * as contact from '@/app/api/v1/contacts/[id]/route';
import * as conversations from '@/app/api/v1/conversations/route';
import * as conversation from '@/app/api/v1/conversations/[id]/route';
import * as conversationMessages from '@/app/api/v1/conversations/[id]/messages/route';
import * as messages from '@/app/api/v1/messages/route';
import * as broadcasts from '@/app/api/v1/broadcasts/route';
import * as broadcast from '@/app/api/v1/broadcasts/[id]/route';
import * as webhooks from '@/app/api/v1/webhooks/route';
import * as webhook from '@/app/api/v1/webhooks/[id]/route';
import * as me from '@/app/api/v1/me/route';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Args = Record<string, any>;

export type ToolKind = 'read' | 'write' | 'confirm';

export interface McpToolDef {
  name: string;
  title: string;
  description: string;
  kind: ToolKind;
  input: z.ZodRawShape;
  route: ApiRouteHandler<any>;
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  path: (a: Args) => string;
  params?: (a: Args) => Record<string, string>;
  query?: (a: Args) => Record<string, unknown>;
  body?: (a: Args) => Record<string, unknown>;
}

const page = {
  limit: z.number().int().min(1).max(100).optional().describe('Itens por página, 1 a 100 (padrão 50).'),
  cursor: z.string().optional().describe('Cursor next_cursor da página anterior.'),
};
const id = (what: string) => z.string().describe(`ID ${what}.`);
const confirmar = z
  .literal(true)
  .describe('Obrigatório: true. Confirme com o usuário antes, esta ação não pode ser desfeita.');
const pick = (a: Args, keys: string[]) =>
  Object.fromEntries(keys.filter((k) => a[k] !== undefined).map((k) => [k, a[k]]));

export const MCP_TOOLS: McpToolDef[] = [
  {
    name: 'whoami',
    title: 'Quem sou eu',
    description:
      'Mostra a conta (workspace) do LabCRM ligada a esta chave, o plano e as permissões. Chame primeiro para saber o que é possível.',
    kind: 'read',
    input: {},
    route: me.GET,
    method: 'GET',
    path: () => '/api/v1/me',
  },
  {
    name: 'list_contacts',
    title: 'Listar contatos',
    description: 'Lista contatos, mais novos primeiro. Filtra por busca (nome ou telefone) ou por ID de etiqueta. Paginado.',
    kind: 'read',
    input: { search: z.string().optional().describe('Busca por nome ou telefone.'), tag: z.string().optional().describe('ID da etiqueta.'), ...page },
    route: contacts.GET,
    method: 'GET',
    path: () => '/api/v1/contacts',
    query: (a) => pick(a, ['search', 'tag', 'limit', 'cursor']),
  },
  {
    name: 'get_contact',
    title: 'Ver contato',
    description: 'Lê um contato pelo ID, com suas etiquetas.',
    kind: 'read',
    input: { id: id('do contato') },
    route: contact.GET,
    method: 'GET',
    path: (a) => `/api/v1/contacts/${a.id}`,
    params: (a) => ({ id: a.id }),
  },
  {
    name: 'list_conversations',
    title: 'Listar conversas',
    description: 'Lista conversas, mais novas primeiro. Filtra por status (open, pending, closed) ou por contato. Paginado.',
    kind: 'read',
    input: {
      status: z.enum(['open', 'pending', 'closed']).optional(),
      contact_id: z.string().optional().describe('Só conversas deste contato.'),
      ...page,
    },
    route: conversations.GET,
    method: 'GET',
    path: () => '/api/v1/conversations',
    query: (a) => pick(a, ['status', 'contact_id', 'limit', 'cursor']),
  },
  {
    name: 'get_conversation',
    title: 'Ver conversa',
    description: 'Lê uma conversa pelo ID, com o contato e as etiquetas.',
    kind: 'read',
    input: { id: id('da conversa') },
    route: conversation.GET,
    method: 'GET',
    path: (a) => `/api/v1/conversations/${a.id}`,
    params: (a) => ({ id: a.id }),
  },
  {
    name: 'list_messages',
    title: 'Listar mensagens',
    description: 'Lista as mensagens de uma conversa, mais novas primeiro, com direção, status de entrega e conteúdo. Paginado.',
    kind: 'read',
    input: { conversation_id: id('da conversa'), ...page },
    route: conversationMessages.GET,
    method: 'GET',
    path: (a) => `/api/v1/conversations/${a.conversation_id}/messages`,
    params: (a) => ({ id: a.conversation_id }),
    query: (a) => pick(a, ['limit', 'cursor']),
  },
  {
    name: 'get_broadcast',
    title: 'Ver disparo',
    description: 'Lê um disparo (broadcast) pelo ID: status e contagens de enviados, entregues, lidos e falhas.',
    kind: 'read',
    input: { id: id('do disparo') },
    route: broadcast.GET,
    method: 'GET',
    path: (a) => `/api/v1/broadcasts/${a.id}`,
    params: (a) => ({ id: a.id }),
  },
  {
    name: 'list_webhooks',
    title: 'Listar webhooks',
    description: 'Lista os webhooks de eventos cadastrados nesta conta.',
    kind: 'read',
    input: {},
    route: webhooks.GET,
    method: 'GET',
    path: () => '/api/v1/webhooks',
  },
  {
    name: 'create_contact',
    title: 'Criar contato',
    description: 'Cria um contato, ou devolve o existente com o mesmo telefone. Etiquetas são criadas se não existirem.',
    kind: 'write',
    input: {
      phone: z.string().describe('Telefone no formato +5511999999999.'),
      name: z.string().optional(),
      email: z.string().optional(),
      company: z.string().optional(),
      tags: z.array(z.string()).optional().describe('Nomes das etiquetas.'),
    },
    route: contacts.POST,
    method: 'POST',
    path: () => '/api/v1/contacts',
    body: (a) => pick(a, ['phone', 'name', 'email', 'company', 'tags']),
  },
  {
    name: 'update_contact',
    title: 'Atualizar contato',
    description: 'Atualiza nome, e-mail, empresa ou etiquetas de um contato. Só os campos enviados mudam; tags substitui todas.',
    kind: 'write',
    input: {
      id: id('do contato'),
      name: z.string().nullable().optional(),
      email: z.string().nullable().optional(),
      company: z.string().nullable().optional(),
      tags: z.array(z.string()).optional(),
    },
    route: contact.PATCH,
    method: 'PATCH',
    path: (a) => `/api/v1/contacts/${a.id}`,
    params: (a) => ({ id: a.id }),
    body: (a) => pick(a, ['name', 'email', 'company', 'tags']),
  },
  {
    name: 'send_message',
    title: 'Enviar mensagem no WhatsApp',
    description:
      'Envia uma mensagem de WhatsApp para um telefone (cria o contato e a conversa se preciso). No plano Pro, fora da janela de 24h só modelo aprovado. Mensagem enviada não volta.',
    kind: 'confirm',
    input: {
      to: z.string().describe('Telefone no formato +5511999999999.'),
      type: z.enum(['text', 'template', 'image', 'video', 'document', 'audio']).optional().describe('Padrão: text.'),
      text: z.string().optional().describe('Texto, ou legenda da mídia.'),
      media_url: z.string().optional().describe('URL https da mídia (image, video, document, audio).'),
      filename: z.string().optional(),
      template: z
        .object({
          name: z.string(),
          language: z.string().optional(),
          params: z.array(z.string()).optional(),
        })
        .optional()
        .describe('Obrigatório quando type = template.'),
      name: z.string().optional().describe('Nome para um contato novo.'),
      confirmar,
    },
    route: messages.POST,
    method: 'POST',
    path: () => '/api/v1/messages',
    body: (a) => pick(a, ['to', 'type', 'text', 'media_url', 'filename', 'template', 'name']),
  },
  {
    name: 'send_broadcast',
    title: 'Disparar modelo em massa',
    description: 'Dispara um modelo aprovado para até 1000 telefones. Acompanhe com get_broadcast. Não pode ser desfeito.',
    kind: 'confirm',
    input: {
      name: z.string().optional(),
      template_name: z.string(),
      template_language: z.string().optional(),
      recipients: z
        .array(z.object({ to: z.string(), params: z.array(z.string()).optional() }))
        .min(1)
        .max(1000),
      confirmar,
    },
    route: broadcasts.POST,
    method: 'POST',
    path: () => '/api/v1/broadcasts',
    body: (a) => pick(a, ['name', 'template_name', 'template_language', 'recipients']),
  },
  {
    name: 'delete_webhook',
    title: 'Apagar webhook',
    description: 'Apaga um webhook de eventos desta conta.',
    kind: 'confirm',
    input: { id: id('do webhook'), confirmar },
    route: webhook.DELETE,
    method: 'DELETE',
    path: (a) => `/api/v1/webhooks/${a.id}`,
    params: (a) => ({ id: a.id }),
  },
];
/* eslint-enable @typescript-eslint/no-explicit-any */
