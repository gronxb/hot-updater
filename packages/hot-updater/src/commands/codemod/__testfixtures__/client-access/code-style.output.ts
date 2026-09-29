import { createHotUpdater as makeHotUpdater } from '@hot-updater/server'
import { drizzleAdapter } from '@hot-updater/server/adapters/drizzle'
import { insights } from '@hot-updater/server/plugins/insights'

import { db } from './db'

const database = drizzleAdapter({ db, provider: 'sqlite' })

export const inline = makeHotUpdater({ database, clientAccess: 'public', plugins: [insights()] })

export const multiline = makeHotUpdater({
  database,
  clientAccess: 'public',
  plugins: [insights()]
})
