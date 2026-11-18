// Shared columns for the v1 broadcast endpoints.

export const BROADCAST_COLUMNS =
  'id, name, template_name, template_language, status, total_recipients, sent_count, delivered_count, read_count, replied_count, failed_count, created_at, updated_at';

export const BROADCAST_STATUSES = ['draft', 'scheduled', 'sending', 'sent', 'failed'] as const;

export const RECIPIENT_STATUSES = ['pending', 'sent', 'delivered', 'read', 'replied', 'failed'] as const;

export const RECIPIENT_COLUMNS =
  'id, contact_id, status, sent_at, delivered_at, read_at, replied_at, error_message, whatsapp_message_id, created_at';

/** error_message stamped on recipients a cancel stopped. */
export const CANCELLED_MESSAGE = 'Cancelado antes do envio';
