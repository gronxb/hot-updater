import { createHotUpdater as makeHotUpdater } from '@hot-updater/server'
import { drizzleAdapter } from '@hot-updater/server/adapters/drizzle'

import { db } from './db'

const database = drizzleAdapter({ db, provider: 'sqlite' })

export const inline = makeHotUpdater({ database, clientAccess: { type: 'public' } })

export const multiline = makeHotUpdater({
  database,
  clientAccess: { type: 'public' } as const
})
