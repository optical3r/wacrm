// The WhatsApp webhook (Meta Cloud API, or Coexy's relay). The handlers
// live in src/lib/whatsapp/webhook-processor.ts so the D-API webhook
// (unofficial QR-code connection, Starter plan) can feed the same
// pipeline after translating its events into Meta's shape.
export { GET, POST } from '@/lib/whatsapp/webhook-processor'

export const maxDuration = 60
