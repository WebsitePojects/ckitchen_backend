/**
 * Short-lived memory of "this session id was valid moments ago".
 *
 * WHY: requireAuth checked user_session on EVERY request. In production the database is a
 * network hop away (Supabase), so that one query added a full round trip to every API call
 * and most of a page's load time. Caching a positive answer for a few seconds removes it
 * from nearly every request.
 *
 * Trade-off: a session revoked elsewhere may keep working for up to TTL_MS. Logout and an
 * admin's "revoke this user's sessions" clear the cache in-process immediately, so the
 * window only applies to revocations made by another server process. Negative answers are
 * never cached. Bounded size so memory cannot grow without limit.
 */
const TTL_MS = 15_000;
const MAX_ENTRIES = 5_000;

interface Entry {
  userId: string;
  validUntil: number;
}

const cache = new Map<string, Entry>();

export function isSessionKnownValid(sessionId: string, now: number = Date.now()): boolean {
  const entry = cache.get(sessionId);
  if (!entry) return false;
  if (entry.validUntil <= now) {
    cache.delete(sessionId);
    return false;
  }
  return true;
}

export function rememberValidSession(sessionId: string, userId: string, now: number = Date.now()): void {
  if (cache.size >= MAX_ENTRIES && !cache.has(sessionId)) {
    // Map keeps insertion order: drop the oldest entry.
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(sessionId, { userId, validUntil: now + TTL_MS });
}

/** Call after ending one session (logout). */
export function forgetSession(sessionId: string): void {
  cache.delete(sessionId);
}

/** Call after revoking every session of a user (block, password reset, role change). */
export function forgetUserSessions(userId: string): void {
  for (const [sid, entry] of cache) if (entry.userId === userId) cache.delete(sid);
}

/** Test helper. */
export function clearSessionCache(): void {
  cache.clear();
}
