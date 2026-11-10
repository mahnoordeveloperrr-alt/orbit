// 📦 SESSION BACKUP — Export / Import (backup + share)
// --------------------------
// Export = every live session (trash excluded) serialized to a portable JSON
// file. Import = validate + normalize each entry through the locked v1 schema,
// assign FRESH local ids (never collide with or overwrite existing sessions),
// and append via the local store. Zero network, zero account — works offline,
// matching the extension's local-first rule.
//
// File contract (orbitabs-backup v1):
//   {
//     "app": "orbitabs",
//     "kind": "orbitabs-backup",
//     "version": 1,
//     "exportedAt": ISO string,
//     "count": <live sessions in sessions[]>,
//     "sessions": [ { name, createdAt, windows: [...] } ]   // v1 shape
//   }
//
// The parser is STRICT about the envelope but generous about entries: each
// session goes through normalizeSession() (locked schema), which also accepts
// legacy urls[] docs — so hand-edited or third-party files still import when
// they carry restorable data. Garbage entries are skipped and counted, never
// silently dropped.

import { normalizeSession } from '../../services/sessionSchema';

export const BACKUP_VERSION = 1;

/* ------------------------------------------------------------------ *
 * EXPORT — sessions → JSON string
 * ------------------------------------------------------------------ */

/** Build the portable backup payload from live (non-deleted) sessions. */
export function buildBackupPayload(sessions) {
  const live = (Array.isArray(sessions) ? sessions : [])
    .filter(s => s && !s.deletedAt)
    .map(normalizeSession)
    .filter(Boolean);

  return {
    app: 'orbitabs',
    kind: 'orbitabs-backup',
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    count: live.length,
    sessions: live.map(s => ({
      name: s.name,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      pinned: !!s.pinned, // 📌 survives export → import
      // 🆕 V1.5 metadata survives the round-trip too
      tags: s.tags || [],
      note: s.note || '',
      folder: s.folder || null,
      // v1 windows[] — the ONLY restorable shape (locked schema)
      windows: s.windows
    }))
  };
}

/** Trigger a browser download of the backup file. Returns the filename. */
export function downloadBackupFile(sessions) {
  const payload = buildBackupPayload(sessions);
  const stamp = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const filename = `orbitabs-backup-${stamp}.json`;
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000); // let the download start first
  return { filename, count: payload.count };
}

/** Download ONE session as its own backup file (session card → ⋯ → Export).
 *  Same v1 envelope, `count: 1`, so the file round-trips through Import. */
export function downloadOneSession(session) {
  return downloadBackupFile([session]);
}

/* ------------------------------------------------------------------ *
 * IMPORT — file text → { sessions, skipped }
 * ------------------------------------------------------------------ */

/** Parse + validate a backup file's text. Throws Error with a user-safe
 *  message on a bad envelope; skips (and counts) unusable entries. */
export function parseBackupText(text) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('Not a valid JSON file.');
  }

  if (!raw || typeof raw !== 'object') throw new Error('File is not a backup object.');
  if (raw.kind !== 'orbitabs-backup') {
    throw new Error('This is not an Orbitabs backup file (missing "kind": "orbitabs-backup").');
  }
  if (raw.app !== 'orbitabs') throw new Error('Unknown backup origin.');
  if (raw.version !== 1) {
    const n = Number(raw.version);
    const detail = Number.isFinite(n) && n > 1
      ? 'it was made by a NEWER version of Orbitabs — update the extension, then try importing again.'
      : 'this file uses an unrecognized format.';
    throw new Error(`Unsupported backup version: ${raw.version ?? 'missing'} — ${detail}`);
  }
  if (!Array.isArray(raw.sessions)) throw new Error('Backup has no sessions array.');

  const sessions = [];
  let skipped = 0;
  for (const entry of raw.sessions) {
    const norm = normalizeSession(entry); // locked v1 schema — also upgrades legacy docs
    if (norm) sessions.push(norm);
    else skipped++; // corrupt/empty entry — keep importing the rest
  }

  return { sessions, skipped, exportedAt: raw.exportedAt || null };
}

/**
 * Read a user-picked .json file in the popup. Wraps the input-element dance
 * so the caller stays one line. Rejects with a friendly message on cancel
 * (no-op) and on non-JSON files.
 */
export function pickBackupFile() {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json,.json';
    input.style.display = 'none';

    input.onchange = () => {
      const file = input.files?.[0];
      input.remove();
      if (!file) return reject(Object.assign(new Error('cancelled'), { cancelled: true }));
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('Could not read the file.'));
      reader.onload = () => resolve({ text: String(reader.result || ''), filename: file.name });
      reader.readAsText(file);
    };

    document.body.appendChild(input);
    input.click();
  });
}
