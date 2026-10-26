import { afterEach, describe, expect, it } from 'vitest'
import { isSuperAdminEmail } from './super-admin'

const saved = process.env.SUPER_ADMIN_EMAILS
afterEach(() => {
  process.env.SUPER_ADMIN_EMAILS = saved
})

describe('isSuperAdminEmail', () => {
  it('matches the comma-separated list, ignoring case and spaces', () => {
    process.env.SUPER_ADMIN_EMAILS = ' Owner@Example.com , second@example.com'
    expect(isSuperAdminEmail('owner@example.com')).toBe(true)
    expect(isSuperAdminEmail('SECOND@example.com ')).toBe(true)
    expect(isSuperAdminEmail('someone@example.com')).toBe(false)
  })

  it('lets nobody in when the list is empty', () => {
    process.env.SUPER_ADMIN_EMAILS = ''
    expect(isSuperAdminEmail('owner@example.com')).toBe(false)
    expect(isSuperAdminEmail(null)).toBe(false)
  })
})
