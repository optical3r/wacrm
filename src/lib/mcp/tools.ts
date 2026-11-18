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
import * as pipelines from '@/app/api/v1/pipelines/route';
import * as pipeline from '@/app/api/v1/pipelines/[id]/route';
import * as pipelineStages from '@/app/api/v1/pipelines/[id]/stages/route';
import * as pipelineStage from '@/app/api/v1/pipelines/[id]/stages/[stageId]/route';
import * as deals from '@/app/api/v1/deals/route';
import * as deal from '@/app/api/v1/deals/[id]/route';
import * as quickReplies from '@/app/api/v1/quick-replies/route';
import * as quickReply from '@/app/api/v1/quick-replies/[id]/route';
import * as templates from '@/app/api/v1/templates/route';
import * as template from '@/app/api/v1/templates/[id]/route';
import * as broadcastRecipients from '@/app/api/v1/broadcasts/[id]/recipients/route';
import * as broadcastCancel from '@/app/api/v1/broadcasts/[id]/cancel/route';
import * as team from '@/app/api/v1/team/route';
import * as channels from '@/app/api/v1/channels/route';
import * as leadRotation from '@/app/api/v1/lead-rotation/route';
import * as flows from '@/app/api/v1/flows/route';
import * as flow from '@/app/api/v1/flows/[id]/route';
import * as flowStatus from '@/app/api/v1/flows/[id]/status/route';
import * as flowRuns from '@/app/api/v1/flows/[id]/runs/route';
import * as flowStart from '@/app/api/v1/flows/[id]/start/route';
import * as flowRunStop from '@/app/api/v1/flow-runs/[id]/stop/route';
import * as automations from '@/app/api/v1/automations/route';
import * as automation from '@/app/api/v1/automations/[id]/route';
import * as automationLogs from '@/app/api/v1/automations/[id]/logs/route';
import * as groups from '@/app/api/v1/groups/route';
import * as group from '@/app/api/v1/groups/[id]/route';
import * as notifications from '@/app/api/v1/notifications/route';
import * as notificationsRead from '@/app/api/v1/notifications/read/route';
import * as reportSummary from '@/app/api/v1/reports/summary/route';

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
  // ---- phase 3: pipelines and deals --------------------------------
  {
    name: 'list_pipelines',
    title: 'Listar funis',
    description: 'Lista os funis de vendas com as etapas de cada um, na ordem.',
    kind: 'read',
    input: {},
    route: pipelines.GET,
    method: 'GET',
    path: () => '/api/v1/pipelines',
  },
  {
    name: 'create_pipeline',
    title: 'Criar funil',
    description: 'Cria um funil. Sem stages, recebe as 5 etapas padrão (Novo lead até Ganho).',
    kind: 'write',
    input: {
      name: z.string().describe('Nome do funil.'),
      stages: z
        .array(z.object({ name: z.string(), color: z.string().optional().describe('#rrggbb') }))
        .optional()
        .describe('Etapas na ordem.'),
    },
    route: pipelines.POST,
    method: 'POST',
    path: () => '/api/v1/pipelines',
    body: (a) => pick(a, ['name', 'stages']),
  },
  {
    name: 'rename_pipeline',
    title: 'Renomear funil',
    description: 'Muda o nome de um funil.',
    kind: 'write',
    input: { id: id('do funil'), name: z.string() },
    route: pipeline.PATCH,
    method: 'PATCH',
    path: (a) => `/api/v1/pipelines/${a.id}`,
    params: (a) => ({ id: a.id }),
    body: (a) => pick(a, ['name']),
  },
  {
    name: 'delete_pipeline',
    title: 'Apagar funil',
    description: 'Apaga um funil com TODAS as etapas e TODOS os negócios dele.',
    kind: 'confirm',
    input: { id: id('do funil'), confirmar },
    route: pipeline.DELETE,
    method: 'DELETE',
    path: (a) => `/api/v1/pipelines/${a.id}`,
    params: (a) => ({ id: a.id }),
  },
  {
    name: 'add_pipeline_stage',
    title: 'Adicionar etapa',
    description: 'Adiciona uma etapa no fim de um funil.',
    kind: 'write',
    input: { pipeline_id: id('do funil'), name: z.string(), color: z.string().optional().describe('#rrggbb') },
    route: pipelineStages.POST,
    method: 'POST',
    path: (a) => `/api/v1/pipelines/${a.pipeline_id}/stages`,
    params: (a) => ({ id: a.pipeline_id }),
    body: (a) => pick(a, ['name', 'color']),
  },
  {
    name: 'update_pipeline_stage',
    title: 'Editar etapa',
    description: 'Renomeia, muda a cor ou a posição (0 = primeira) de uma etapa.',
    kind: 'write',
    input: {
      pipeline_id: id('do funil'),
      stage_id: id('da etapa'),
      name: z.string().optional(),
      color: z.string().optional(),
      position: z.number().int().min(0).optional(),
    },
    route: pipelineStage.PATCH,
    method: 'PATCH',
    path: (a) => `/api/v1/pipelines/${a.pipeline_id}/stages/${a.stage_id}`,
    params: (a) => ({ id: a.pipeline_id, stageId: a.stage_id }),
    body: (a) => pick(a, ['name', 'color', 'position']),
  },
  {
    name: 'delete_pipeline_stage',
    title: 'Apagar etapa',
    description: 'Apaga uma etapa vazia. Se houver negócios nela, mova-os antes.',
    kind: 'confirm',
    input: { pipeline_id: id('do funil'), stage_id: id('da etapa'), confirmar },
    route: pipelineStage.DELETE,
    method: 'DELETE',
    path: (a) => `/api/v1/pipelines/${a.pipeline_id}/stages/${a.stage_id}`,
    params: (a) => ({ id: a.pipeline_id, stageId: a.stage_id }),
  },
  {
    name: 'list_deals',
    title: 'Listar negócios',
    description: 'Lista negócios, mais novos primeiro. Filtre por funil, etapa, status, contato ou responsável. Paginado.',
    kind: 'read',
    input: {
      pipeline_id: z.string().optional(),
      stage_id: z.string().optional(),
      status: z.enum(['open', 'won', 'lost']).optional(),
      contact_id: z.string().optional(),
      assigned_to: z.string().optional().describe('ID de usuário do responsável.'),
      ...page,
    },
    route: deals.GET,
    method: 'GET',
    path: () => '/api/v1/deals',
    query: (a) => pick(a, ['pipeline_id', 'stage_id', 'status', 'contact_id', 'assigned_to', 'limit', 'cursor']),
  },
  {
    name: 'get_deal',
    title: 'Ver negócio',
    description: 'Lê um negócio pelo ID.',
    kind: 'read',
    input: { id: id('do negócio') },
    route: deal.GET,
    method: 'GET',
    path: (a) => `/api/v1/deals/${a.id}`,
    params: (a) => ({ id: a.id }),
  },
  {
    name: 'create_deal',
    title: 'Criar negócio',
    description:
      'Cria um negócio num funil. Sem stage_id vai para a primeira etapa; sem currency usa a moeda da conta.',
    kind: 'write',
    input: {
      title: z.string(),
      pipeline_id: id('do funil'),
      stage_id: z.string().optional(),
      value: z.number().min(0).optional(),
      currency: z.string().optional().describe('Código de 3 letras, como BRL.'),
      contact_id: z.string().optional(),
      conversation_id: z.string().optional(),
      assigned_to: z.string().optional().describe('ID de usuário do responsável.'),
      notes: z.string().optional(),
      expected_close_date: z.string().optional().describe('AAAA-MM-DD'),
    },
    route: deals.POST,
    method: 'POST',
    path: () => '/api/v1/deals',
    body: (a) =>
      pick(a, [
        'title', 'pipeline_id', 'stage_id', 'value', 'currency', 'contact_id',
        'conversation_id', 'assigned_to', 'notes', 'expected_close_date',
      ]),
  },
  {
    name: 'update_deal',
    title: 'Editar ou mover negócio',
    description:
      'Edita um negócio, move de etapa (stage_id) ou de funil (pipeline_id) e marca como ganho/perdido (status won/lost) ou reabre (open).',
    kind: 'write',
    input: {
      id: id('do negócio'),
      title: z.string().optional(),
      pipeline_id: z.string().optional(),
      stage_id: z.string().optional(),
      status: z.enum(['open', 'won', 'lost']).optional(),
      value: z.number().min(0).optional(),
      currency: z.string().optional(),
      contact_id: z.string().nullable().optional(),
      assigned_to: z.string().nullable().optional(),
      notes: z.string().nullable().optional(),
      expected_close_date: z.string().nullable().optional(),
    },
    route: deal.PATCH,
    method: 'PATCH',
    path: (a) => `/api/v1/deals/${a.id}`,
    params: (a) => ({ id: a.id }),
    body: (a) =>
      pick(a, [
        'title', 'pipeline_id', 'stage_id', 'status', 'value', 'currency',
        'contact_id', 'assigned_to', 'notes', 'expected_close_date',
      ]),
  },
  {
    name: 'delete_deal',
    title: 'Apagar negócio',
    description: 'Apaga um negócio.',
    kind: 'confirm',
    input: { id: id('do negócio'), confirmar },
    route: deal.DELETE,
    method: 'DELETE',
    path: (a) => `/api/v1/deals/${a.id}`,
    params: (a) => ({ id: a.id }),
  },
  // ---- phase 3: quick replies ---------------------------------------
  {
    name: 'list_quick_replies',
    title: 'Listar respostas rápidas',
    description: 'Lista as respostas rápidas da conta (texto ou mensagem interativa com botões/lista).',
    kind: 'read',
    input: {},
    route: quickReplies.GET,
    method: 'GET',
    path: () => '/api/v1/quick-replies',
  },
  {
    name: 'create_quick_reply',
    title: 'Criar resposta rápida',
    description: 'Cria uma resposta rápida de texto (kind text + content_text) ou interativa (kind interactive + interactive_payload).',
    kind: 'write',
    input: {
      title: z.string(),
      kind: z.enum(['text', 'interactive']).optional(),
      content_text: z.string().optional(),
      interactive_payload: z.record(z.string(), z.unknown()).optional(),
    },
    route: quickReplies.POST,
    method: 'POST',
    path: () => '/api/v1/quick-replies',
    body: (a) => pick(a, ['title', 'kind', 'content_text', 'interactive_payload']),
  },
  {
    name: 'update_quick_reply',
    title: 'Editar resposta rápida',
    description: 'Muda o título e/ou o conteúdo de uma resposta rápida.',
    kind: 'write',
    input: {
      id: id('da resposta rápida'),
      title: z.string().optional(),
      kind: z.enum(['text', 'interactive']).optional(),
      content_text: z.string().optional(),
      interactive_payload: z.record(z.string(), z.unknown()).optional(),
    },
    route: quickReply.PATCH,
    method: 'PATCH',
    path: (a) => `/api/v1/quick-replies/${a.id}`,
    params: (a) => ({ id: a.id }),
    body: (a) => pick(a, ['title', 'kind', 'content_text', 'interactive_payload']),
  },
  {
    name: 'delete_quick_reply',
    title: 'Apagar resposta rápida',
    description: 'Apaga uma resposta rápida.',
    kind: 'confirm',
    input: { id: id('da resposta rápida'), confirmar },
    route: quickReply.DELETE,
    method: 'DELETE',
    path: (a) => `/api/v1/quick-replies/${a.id}`,
    params: (a) => ({ id: a.id }),
  },
  // ---- phase 3: templates (Pro) --------------------------------------
  {
    name: 'list_templates',
    title: 'Listar modelos',
    description: 'Lista os modelos de mensagem (templates) e o status de aprovação na Meta. Só no plano Pro.',
    kind: 'read',
    input: {
      status: z.string().optional().describe('APPROVED, PENDING, REJECTED, DRAFT...'),
      language: z.string().optional().describe('Ex.: pt_BR'),
    },
    route: templates.GET,
    method: 'GET',
    path: () => '/api/v1/templates',
    query: (a) => pick(a, ['status', 'language']),
  },
  {
    name: 'get_template',
    title: 'Ver modelo',
    description: 'Lê um modelo de mensagem, com o motivo da recusa quando houver. Só no plano Pro.',
    kind: 'read',
    input: { id: id('do modelo') },
    route: template.GET,
    method: 'GET',
    path: (a) => `/api/v1/templates/${a.id}`,
    params: (a) => ({ id: a.id }),
  },
  {
    name: 'create_template',
    title: 'Criar modelo e enviar para aprovação',
    description:
      'Cria um modelo de mensagem e envia para aprovação da Meta. name em minúsculas_com_underline; variáveis {{1}}, {{2}} no body_text com exemplos em sample_values. Só no plano Pro.',
    kind: 'confirm',
    input: {
      name: z.string(),
      category: z.enum(['Marketing', 'Utility']),
      language: z.string().describe('Ex.: pt_BR'),
      body_text: z.string(),
      header_type: z.enum(['text', 'image', 'video', 'document']).optional(),
      header_content: z.string().optional(),
      header_media_url: z.string().optional(),
      footer_text: z.string().optional(),
      buttons: z.array(z.record(z.string(), z.unknown())).optional(),
      sample_values: z.record(z.string(), z.unknown()).optional(),
      confirmar,
    },
    route: templates.POST,
    method: 'POST',
    path: () => '/api/v1/templates',
    body: (a) =>
      pick(a, [
        'name', 'category', 'language', 'body_text', 'header_type', 'header_content',
        'header_media_url', 'footer_text', 'buttons', 'sample_values',
      ]),
  },
  {
    name: 'delete_template',
    title: 'Apagar modelo',
    description: 'Apaga um modelo na Meta e no LabCRM. Só no plano Pro.',
    kind: 'confirm',
    input: { id: id('do modelo'), confirmar },
    route: template.DELETE,
    method: 'DELETE',
    path: (a) => `/api/v1/templates/${a.id}`,
    params: (a) => ({ id: a.id }),
  },
  // ---- phase 3: broadcasts --------------------------------------------
  {
    name: 'list_broadcasts',
    title: 'Listar disparos',
    description: 'Lista os disparos, mais novos primeiro, com status e contagens. Só no plano Pro. Paginado.',
    kind: 'read',
    input: { status: z.enum(['draft', 'scheduled', 'sending', 'sent', 'failed']).optional(), ...page },
    route: broadcasts.GET,
    method: 'GET',
    path: () => '/api/v1/broadcasts',
    query: (a) => pick(a, ['status', 'limit', 'cursor']),
  },
  {
    name: 'list_broadcast_recipients',
    title: 'Ver destinatários do disparo',
    description: 'Lista os destinatários de um disparo com o status de cada um (enviado, entregue, lido, respondeu, falhou). Paginado.',
    kind: 'read',
    input: {
      id: id('do disparo'),
      status: z.enum(['pending', 'sent', 'delivered', 'read', 'replied', 'failed']).optional(),
      ...page,
    },
    route: broadcastRecipients.GET,
    method: 'GET',
    path: (a) => `/api/v1/broadcasts/${a.id}/recipients`,
    params: (a) => ({ id: a.id }),
    query: (a) => pick(a, ['status', 'limit', 'cursor']),
  },
  {
    name: 'cancel_broadcast',
    title: 'Cancelar disparo',
    description: 'Para um disparo em andamento. Quem ainda não recebeu não recebe mais; o que já foi enviado continua enviado.',
    kind: 'confirm',
    input: { id: id('do disparo'), confirmar },
    route: broadcastCancel.POST,
    method: 'POST',
    path: (a) => `/api/v1/broadcasts/${a.id}/cancel`,
    params: (a) => ({ id: a.id }),
  },
  // ---- phase 3: team and numbers --------------------------------------
  {
    name: 'list_team',
    title: 'Listar equipe',
    description: 'Lista as pessoas da conta com o papel de cada uma (owner, admin, agent, viewer). Use os user_id como donos e responsáveis.',
    kind: 'read',
    input: {},
    route: team.GET,
    method: 'GET',
    path: () => '/api/v1/team',
  },
  {
    name: 'list_channels',
    title: 'Listar números',
    description: 'Lista os números de WhatsApp conectados, o status e os atendentes ligados a cada um.',
    kind: 'read',
    input: {},
    route: channels.GET,
    method: 'GET',
    path: () => '/api/v1/channels',
  },
  {
    name: 'get_lead_rotation',
    title: 'Ver rodízio de leads',
    description: 'Mostra se o rodízio de leads está ligado, quem participa e quem recebeu o último lead.',
    kind: 'read',
    input: {},
    route: leadRotation.GET,
    method: 'GET',
    path: () => '/api/v1/lead-rotation',
  },
  // ---- phase 4: flows ------------------------------------------------
  {
    name: 'list_flows',
    title: 'Listar fluxos',
    description: 'Lista os fluxos (chatbots) da conta com status, gatilho e quantas vezes rodaram.',
    kind: 'read',
    input: { status: z.enum(['draft', 'active', 'archived']).optional() },
    route: flows.GET,
    method: 'GET',
    path: () => '/api/v1/flows',
    query: (a) => pick(a, ['status']),
  },
  {
    name: 'get_flow',
    title: 'Ver fluxo',
    description: 'Lê um fluxo com todos os blocos (nós) e a configuração de cada um.',
    kind: 'read',
    input: { id: id('do fluxo') },
    route: flow.GET,
    method: 'GET',
    path: (a) => `/api/v1/flows/${a.id}`,
    params: (a) => ({ id: a.id }),
  },
  {
    name: 'set_flow_status',
    title: 'Ligar ou desligar fluxo',
    description: 'Ativa (active), volta para rascunho (draft) ou arquiva (archived) um fluxo. Ativar faz as mesmas checagens do editor.',
    kind: 'write',
    input: { id: id('do fluxo'), status: z.enum(['draft', 'active', 'archived']) },
    route: flowStatus.POST,
    method: 'POST',
    path: (a) => `/api/v1/flows/${a.id}/status`,
    params: (a) => ({ id: a.id }),
    body: (a) => pick(a, ['status']),
  },
  {
    name: 'list_flow_runs',
    title: 'Ver execuções do fluxo',
    description: 'Lista as execuções mais recentes de um fluxo: contato, status, bloco atual e motivo do fim.',
    kind: 'read',
    input: {
      id: id('do fluxo'),
      status: z.enum(['active', 'completed', 'handed_off', 'timed_out', 'paused_by_agent', 'failed']).optional(),
      limit: page.limit,
    },
    route: flowRuns.GET,
    method: 'GET',
    path: (a) => `/api/v1/flows/${a.id}/runs`,
    params: (a) => ({ id: a.id }),
    query: (a) => pick(a, ['status', 'limit']),
  },
  {
    name: 'start_flow',
    title: 'Iniciar fluxo para um contato',
    description: 'Inicia um fluxo ativo para o contato de uma conversa. O fluxo manda mensagens ao cliente.',
    kind: 'confirm',
    input: { id: id('do fluxo'), conversation_id: id('da conversa'), confirmar },
    route: flowStart.POST,
    method: 'POST',
    path: (a) => `/api/v1/flows/${a.id}/start`,
    params: (a) => ({ id: a.id }),
    body: (a) => pick(a, ['conversation_id']),
  },
  {
    name: 'stop_flow_run',
    title: 'Parar execução de fluxo',
    description: 'Para uma execução de fluxo em andamento (o contato sai do fluxo).',
    kind: 'write',
    input: { id: id('da execução (flow_run_id)') },
    route: flowRunStop.POST,
    method: 'POST',
    path: (a) => `/api/v1/flow-runs/${a.id}/stop`,
    params: (a) => ({ id: a.id }),
  },
  // ---- phase 4: automations --------------------------------------------
  {
    name: 'list_automations',
    title: 'Listar automações',
    description: 'Lista as automações com gatilho, se estão ligadas e quantas vezes rodaram.',
    kind: 'read',
    input: { active: z.enum(['true', 'false']).optional() },
    route: automations.GET,
    method: 'GET',
    path: () => '/api/v1/automations',
    query: (a) => pick(a, ['active']),
  },
  {
    name: 'get_automation',
    title: 'Ver automação',
    description: 'Lê uma automação com todos os passos.',
    kind: 'read',
    input: { id: id('da automação') },
    route: automation.GET,
    method: 'GET',
    path: (a) => `/api/v1/automations/${a.id}`,
    params: (a) => ({ id: a.id }),
  },
  {
    name: 'set_automation_active',
    title: 'Ligar ou desligar automação',
    description: 'Liga (true) ou desliga (false) uma automação. Ligar faz as mesmas checagens do editor.',
    kind: 'write',
    input: { id: id('da automação'), is_active: z.boolean() },
    route: automation.PATCH,
    method: 'PATCH',
    path: (a) => `/api/v1/automations/${a.id}`,
    params: (a) => ({ id: a.id }),
    body: (a) => pick(a, ['is_active']),
  },
  {
    name: 'list_automation_logs',
    title: 'Ver histórico da automação',
    description: 'Lista as execuções mais recentes de uma automação, com status e erro quando houver.',
    kind: 'read',
    input: { id: id('da automação'), limit: page.limit },
    route: automationLogs.GET,
    method: 'GET',
    path: (a) => `/api/v1/automations/${a.id}/logs`,
    params: (a) => ({ id: a.id }),
    query: (a) => pick(a, ['limit']),
  },
  // ---- phase 4: groups (Starter) and sending into a chat ---------------
  {
    name: 'list_groups',
    title: 'Listar grupos',
    description: 'Lista os grupos de WhatsApp dos números da conta. Só no plano Starter. hidden=true mostra os ocultos.',
    kind: 'read',
    input: { hidden: z.enum(['true', 'false']).optional() },
    route: groups.GET,
    method: 'GET',
    path: () => '/api/v1/groups',
    query: (a) => pick(a, ['hidden']),
  },
  {
    name: 'set_group_hidden',
    title: 'Ocultar ou mostrar grupo',
    description: 'Oculta um grupo da caixa de entrada (as mensagens novas dele deixam de ser salvas) ou mostra de novo. Só no Starter.',
    kind: 'write',
    input: { id: id('do grupo (conversa)'), hidden: z.boolean() },
    route: group.PATCH,
    method: 'PATCH',
    path: (a) => `/api/v1/groups/${a.id}`,
    params: (a) => ({ id: a.id }),
    body: (a) => pick(a, ['hidden']),
  },
  {
    name: 'send_to_conversation',
    title: 'Enviar mensagem numa conversa',
    description:
      'Envia uma mensagem de texto (ou mídia por media_url) numa conversa que já existe, inclusive grupo no plano Starter.',
    kind: 'confirm',
    input: {
      conversation_id: id('da conversa ou grupo'),
      type: z.enum(['text', 'image', 'video', 'audio', 'document']).optional(),
      text: z.string().optional(),
      media_url: z.string().optional(),
      filename: z.string().optional(),
      confirmar,
    },
    route: conversationMessages.POST,
    method: 'POST',
    path: (a) => `/api/v1/conversations/${a.conversation_id}/messages`,
    params: (a) => ({ id: a.conversation_id }),
    body: (a) => pick(a, ['type', 'text', 'media_url', 'filename']),
  },
  // ---- phase 4: notifications and reports -------------------------------
  {
    name: 'list_notifications',
    title: 'Ver notificações',
    description: 'Lista as notificações de quem criou a chave, mais novas primeiro.',
    kind: 'read',
    input: { unread: z.enum(['true', 'false']).optional(), limit: page.limit },
    route: notifications.GET,
    method: 'GET',
    path: () => '/api/v1/notifications',
    query: (a) => pick(a, ['unread', 'limit']),
  },
  {
    name: 'mark_notifications_read',
    title: 'Marcar notificações como lidas',
    description: 'Marca como lidas as notificações indicadas em ids, ou todas as não lidas se ids não vier.',
    kind: 'write',
    input: { ids: z.array(z.string()).optional() },
    route: notificationsRead.POST,
    method: 'POST',
    path: () => '/api/v1/notifications/read',
    body: (a) => pick(a, ['ids']),
  },
  {
    name: 'get_report_summary',
    title: 'Resumo do painel',
    description:
      'Números da conta num período (days, padrão 30): conversas por status e por dono, contatos novos, negócios abertos/ganhos/perdidos, fluxos e disparos.',
    kind: 'read',
    input: { days: z.number().int().min(1).max(365).optional() },
    route: reportSummary.GET,
    method: 'GET',
    path: () => '/api/v1/reports/summary',
    query: (a) => pick(a, ['days']),
  },
];
/* eslint-enable @typescript-eslint/no-explicit-any */
