import type { CreateEventType } from '@calendar/api-client';

import { operationStorage } from './operation-storage';
const storage = operationStorage<CreationContext>(
  'owner-event-type-operation',
  'owner_event_type_operation',
);
export const loadCreationContext = storage.load;
export const persistCreation = storage.persist;
export const clearCreation = storage.clear;
export type CreationContext = { key: string; fingerprint: string; parameters?: CreateEventType };
// Only unsent drafts live here. Routing through login preserves them; reload discards them.
export const typeDraft = { name: '', description: '', duration: '30' };
export function resetDraft() {
  Object.assign(typeDraft, { name: '', description: '', duration: '30' });
}
export async function fingerprint(parameters: CreateEventType) {
  const canonical = JSON.stringify([
    parameters.name.trim(),
    parameters.description ?? '',
    parameters.durationMinutes,
  ]);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
