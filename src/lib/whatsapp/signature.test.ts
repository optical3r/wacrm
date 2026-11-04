import { describe, expect, it } from 'vitest'
import { signText } from './signature'

describe('signText', () => {
  it('prefixes the attendant name in bold', () => {
    expect(signText('Ana Souza', 'Olá!')).toBe('*Ana Souza:*\nOlá!')
  })
  it('strips WhatsApp formatting marks and line breaks from the name', () => {
    expect(signText('*Ana*_\n', 'Oi')).toBe('*Ana:*\nOi')
  })
  it('leaves the text alone without a name or text', () => {
    expect(signText(null, 'Oi')).toBe('Oi')
    expect(signText('  ', 'Oi')).toBe('Oi')
    expect(signText('Ana', '   ')).toBe('   ')
  })
  it('does not sign twice', () => {
    expect(signText('Ana', '*Ana:*\nOi')).toBe('*Ana:*\nOi')
  })
})
