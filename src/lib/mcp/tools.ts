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
import * as contactsImport from '@/app/api/v1/contacts/import/route';
import * as contactTags from '@/app/api/v1/contacts/[id]/tags/route';
import * as contactTag from '@/app/api/v1/contacts/[id]/tags/[tagId]/route';
import * as contactFields from '@/app/api/v1/contacts/[id]/fields/route';
import * as contactNotes from '@/app/api/v1/contacts/[id]/notes/route';
import * as tags from '@/app/api/v1/tags/route';
import * as tag from '@/app/api/v1/tags/[id]/route';
import * as fields from '@/app/api/v1/fields/route';
import * as field from '@/app/api/v1/fields/[id]/route';
import * as note from '@/app/api/v1/notes/[id]/route';
import * as conversationRead from '@/app/api/v1/conversations/[id]/read/route';

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
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
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
    description:
      'Lista conversas, mais novas primeiro. Filtra por status (open, pending, closed), contato, dono do lead, sem dono, número conectado ou só não lidas. Paginado.',
    kind: 'read',
    input: {
      status: z.enum(['open', 'pending', 'closed']).optional(),
      contact_id: z.string().optional().describe('Só conversas deste contato.'),
      owner_id: z.string().optional().describe('Só leads deste dono (ID de usuário).'),
      unassigned: z.boolean().optional().describe('true = só leads sem dono.'),
      channel_id: z.string().optional().describe('Só conversas que passaram por este número.'),
      unread: z.boolean().optional().describe('true = só conversas com mensagens não lidas.'),
      ...page,
    },
    route: conversations.GET,
    method: 'GET',
    path: () => '/api/v1/conversations',
    query: (a) =>
      pick(a, ['status', 'contact_id', 'owner_id', 'unassigned', 'channel_id', 'unread', 'limit', 'cursor']),
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

  // ---- phase 2: tags ------------------------------------------------
  {
    name: 'list_tags',
    title: 'Listar etiquetas',
    description: 'Lista as etiquetas do workspace.',
    kind: 'read',
    input: {},
    route: tags.GET,
    method: 'GET',
    path: () => '/api/v1/tags',
  },
  {
    name: 'create_tag',
    title: 'Criar etiqueta',
    description: 'Cria uma etiqueta (ou devolve a que já tem esse nome).',
    kind: 'write',
    input: { name: z.string(), color: z.string().optional().describe('Cor #rrggbb.') },
    route: tags.POST,
    method: 'POST',
    path: () => '/api/v1/tags',
    body: (a) => pick(a, ['name', 'color']),
  },
  {
    name: 'update_tag',
    title: 'Editar etiqueta',
    description: 'Renomeia ou muda a cor de uma etiqueta.',
    kind: 'write',
    input: { id: id('da etiqueta'), name: z.string().optional(), color: z.string().optional() },
    route: tag.PATCH,
    method: 'PATCH',
    path: (a) => `/api/v1/tags/${a.id}`,
    params: (a) => ({ id: a.id }),
    body: (a) => pick(a, ['name', 'color']),
  },
  {
    name: 'delete_tag',
    title: 'Apagar etiqueta',
    description: 'Apaga uma etiqueta e a tira de todos os contatos.',
    kind: 'confirm',
    input: { id: id('da etiqueta'), confirmar },
    route: tag.DELETE,
    method: 'DELETE',
    path: (a) => `/api/v1/tags/${a.id}`,
    params: (a) => ({ id: a.id }),
  },
  {
    name: 'add_contact_tags',
    title: 'Pôr etiquetas no contato',
    description:
      'Adiciona etiquetas a um contato, por nome (cria as que não existem) ou por ID. Dispara as automações de "etiqueta adicionada".',
    kind: 'write',
    input: {
      contact_id: id('do contato'),
      names: z.array(z.string()).optional().describe('Nomes das etiquetas.'),
      tag_id: z.string().optional().describe('Ou o ID de uma etiqueta.'),
    },
    route: contactTags.POST,
    method: 'POST',
    path: (a) => `/api/v1/contacts/${a.contact_id}/tags`,
    params: (a) => ({ id: a.contact_id }),
    body: (a) => pick(a, ['names', 'tag_id']),
  },
  {
    name: 'remove_contact_tag',
    title: 'Tirar etiqueta do contato',
    description: 'Tira uma etiqueta de um contato. A etiqueta continua existindo.',
    kind: 'write',
    input: { contact_id: id('do contato'), tag_id: id('da etiqueta') },
    route: contactTag.DELETE,
    method: 'DELETE',
    path: (a) => `/api/v1/contacts/${a.contact_id}/tags/${a.tag_id}`,
    params: (a) => ({ id: a.contact_id, tagId: a.tag_id }),
  },
  // ---- phase 2: custom fields ---------------------------------------
  {
    name: 'list_fields',
    title: 'Listar campos personalizados',
    description: 'Lista os campos personalizados de contato do workspace.',
    kind: 'read',
    input: {},
    route: fields.GET,
    method: 'GET',
    path: () => '/api/v1/fields',
  },
  {
    name: 'create_field',
    title: 'Criar campo personalizado',
    description: 'Cria um campo de texto para os contatos (ex.: CPF, Cidade).',
    kind: 'write',
    input: { name: z.string() },
    route: fields.POST,
    method: 'POST',
    path: () => '/api/v1/fields',
    body: (a) => pick(a, ['name']),
  },
  {
    name: 'rename_field',
    title: 'Renomear campo personalizado',
    description: 'Muda o nome de um campo personalizado.',
    kind: 'write',
    input: { id: id('do campo'), name: z.string() },
    route: field.PATCH,
    method: 'PATCH',
    path: (a) => `/api/v1/fields/${a.id}`,
    params: (a) => ({ id: a.id }),
    body: (a) => pick(a, ['name']),
  },
  {
    name: 'delete_field',
    title: 'Apagar campo personalizado',
    description: 'Apaga um campo e o valor dele em todos os contatos.',
    kind: 'confirm',
    input: { id: id('do campo'), confirmar },
    route: field.DELETE,
    method: 'DELETE',
    path: (a) => `/api/v1/fields/${a.id}`,
    params: (a) => ({ id: a.id }),
  },
  {
    name: 'get_contact_fields',
    title: 'Ver campos do contato',
    description: 'Mostra todos os campos personalizados com o valor deste contato.',
    kind: 'read',
    input: { contact_id: id('do contato') },
    route: contactFields.GET,
    method: 'GET',
    path: (a) => `/api/v1/contacts/${a.contact_id}/fields`,
    params: (a) => ({ id: a.contact_id }),
  },
  {
    name: 'set_contact_fields',
    title: 'Gravar campos do contato',
    description: 'Grava valores de campos personalizados num contato. null apaga o valor.',
    kind: 'write',
    input: {
      contact_id: id('do contato'),
      values: z.record(z.string(), z.string().nullable()).describe('{ ID do campo: valor }'),
    },
    route: contactFields.PUT,
    method: 'PUT',
    path: (a) => `/api/v1/contacts/${a.contact_id}/fields`,
    params: (a) => ({ id: a.contact_id }),
    body: (a) => pick(a, ['values']),
  },
  // ---- phase 2: notes -----------------------------------------------
  {
    name: 'list_contact_notes',
    title: 'Ver notas do contato',
    description: 'Lista as notas de um contato, mais novas primeiro.',
    kind: 'read',
    input: { contact_id: id('do contato') },
    route: contactNotes.GET,
    method: 'GET',
    path: (a) => `/api/v1/contacts/${a.contact_id}/notes`,
    params: (a) => ({ id: a.contact_id }),
  },
  {
    name: 'add_contact_note',
    title: 'Adicionar nota',
    description: 'Escreve uma nota interna num contato (o cliente não vê).',
    kind: 'write',
    input: { contact_id: id('do contato'), text: z.string() },
    route: contactNotes.POST,
    method: 'POST',
    path: (a) => `/api/v1/contacts/${a.contact_id}/notes`,
    params: (a) => ({ id: a.contact_id }),
    body: (a) => pick(a, ['text']),
  },
  {
    name: 'update_note',
    title: 'Editar nota',
    description: 'Troca o texto de uma nota.',
    kind: 'write',
    input: { id: id('da nota'), text: z.string() },
    route: note.PATCH,
    method: 'PATCH',
    path: (a) => `/api/v1/notes/${a.id}`,
    params: (a) => ({ id: a.id }),
    body: (a) => pick(a, ['text']),
  },
  {
    name: 'delete_note',
    title: 'Apagar nota',
    description: 'Apaga uma nota.',
    kind: 'confirm',
    input: { id: id('da nota'), confirmar },
    route: note.DELETE,
    method: 'DELETE',
    path: (a) => `/api/v1/notes/${a.id}`,
    params: (a) => ({ id: a.id }),
  },
  // ---- phase 2: contacts --------------------------------------------
  {
    name: 'import_contacts',
    title: 'Importar contatos',
    description:
      'Cria até 500 contatos de uma vez (os que já existem são mantidos e só ganham as etiquetas). Devolve o resultado de cada linha.',
    kind: 'write',
    input: {
      contacts: z
        .array(
          z.object({
            phone: z.string(),
            name: z.string().optional(),
            email: z.string().optional(),
            company: z.string().optional(),
            tags: z.array(z.string()).optional(),
          })
        )
        .min(1)
        .max(500),
    },
    route: contactsImport.POST,
    method: 'POST',
    path: () => '/api/v1/contacts/import',
    body: (a) => pick(a, ['contacts']),
  },
  {
    name: 'delete_contact',
    title: 'Apagar contato',
    description: 'Apaga um contato junto com as conversas, mensagens, notas e negócios dele.',
    kind: 'confirm',
    input: { id: id('do contato'), confirmar },
    route: contact.DELETE,
    method: 'DELETE',
    path: (a) => `/api/v1/contacts/${a.id}`,
    params: (a) => ({ id: a.id }),
  },
  // ---- phase 2: conversations ---------------------------------------
  {
    name: 'start_conversation',
    title: 'Abrir conversa com um número',
    description:
      'Abre (ou encontra) a conversa com um telefone, criando o contato se preciso. Não envia nada; use send_message depois.',
    kind: 'write',
    input: {
      phone: z.string().describe('+5511999999999, ou DDD e número para o Brasil.'),
      name: z.string().optional().describe('Nome para um contato novo.'),
    },
    route: conversations.POST,
    method: 'POST',
    path: () => '/api/v1/conversations',
    body: (a) => pick(a, ['phone', 'name']),
  },
  {
    name: 'update_conversation',
    title: 'Mudar status ou donos da conversa',
    description:
      'Muda o status (open, pending, closed) e/ou os donos do lead. owner_ids substitui a lista inteira; [] deixa sem dono. Os novos donos são notificados.',
    kind: 'write',
    input: {
      id: id('da conversa'),
      status: z.enum(['open', 'pending', 'closed']).optional(),
      owner_ids: z.array(z.string()).optional().describe('IDs de usuário dos donos.'),
    },
    route: conversation.PATCH,
    method: 'PATCH',
    path: (a) => `/api/v1/conversations/${a.id}`,
    params: (a) => ({ id: a.id }),
    body: (a) => pick(a, ['status', 'owner_ids']),
  },
  {
    name: 'mark_conversation_read',
    title: 'Marcar conversa como lida',
    description: 'Zera as não lidas no CRM e marca as mensagens do cliente como lidas no WhatsApp (tique azul).',
    kind: 'write',
    input: { id: id('da conversa') },
    route: conversationRead.POST,
    method: 'POST',
    path: (a) => `/api/v1/conversations/${a.id}/read`,
    params: (a) => ({ id: a.id }),
  },
];
/* eslint-enable @typescript-eslint/no-explicit-any */
