import Dexie from 'dexie'

export const db = new Dexie('rp-engine')

db.version(1).stores({
  characters: '++id, name',
  sessions: '++id, updatedAt',
  messages: '++id, sessionId',
  lore: '++id',
  tasks: '++id, sessionId, status',
})

export async function getMessages(sessionId) {
  return (await db.messages.where('sessionId').equals(sessionId).toArray())
    .sort((a, b) => a.id - b.id)
}

export function emptyState() {
  return { characters: {}, facts: [], events: [], relations: [] }
}
