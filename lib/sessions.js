import { randomUUID } from 'crypto';
import { readJsonFile, writeJsonFile } from './helpers.js';

/**
 * Session persistence for CosmoMail. No database — all short-term state lives in
 * a single JSON file shaped as { sessions: [ SessionRecord, ... ] }.
 *
 * A SessionRecord captures the full exercise state for assessment:
 *   {
 *     session_id, scenario_id, created_at, updated_at,
 *     octavus_session_id,        // set lazily when the agent is first used
 *     threads: [...],            // seeded inbox + learner sends + recipient replies
 *     drafts: [ { to, cc, subject, body(markdown), updated_at } ],
 *     assistant_messages: [ { role, content, files, timestamp } ]
 *   }
 */

export function newSessionRecord(scenarioId, threads = []) {
  const now = new Date().toISOString();
  return {
    session_id: randomUUID(),
    scenario_id: scenarioId ?? null,
    created_at: now,
    updated_at: now,
    octavus_session_id: null,
    threads: structuredClone(threads),
    drafts: [],
    assistant_messages: [],
    character_sessions: {},
    character_done: {},
  };
}

export const readSessionsFile = (file) => readJsonFile(file, { sessions: [] });
export const writeSessionsFile = (file, data) => writeJsonFile(file, data);

export function findSession(data, sessionId) {
  return data.sessions.find((s) => s.session_id === sessionId) ?? null;
}

export function latestSession(data) {
  if (!data.sessions.length) return null;
  return data.sessions.reduce((a, b) =>
    (a.updated_at || a.created_at) > (b.updated_at || b.created_at) ? a : b,
  );
}

export function upsertSession(data, record) {
  const idx = data.sessions.findIndex((s) => s.session_id === record.session_id);
  record.updated_at = new Date().toISOString();
  if (idx >= 0) data.sessions[idx] = record;
  else data.sessions.push(record);
  return data;
}

export function removeSession(data, sessionId) {
  data.sessions = data.sessions.filter((s) => s.session_id !== sessionId);
  return data;
}

// A trimmed client view of a session (no need to ship internal fields raw).
export function toClientSession(record) {
  return {
    sessionId: record.session_id,
    scenarioId: record.scenario_id,
    threads: record.threads,
    drafts: record.drafts,
    assistantMessages: record.assistant_messages,
  };
}
