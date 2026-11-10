import React, { useState, useEffect } from 'react';
import { X, Tag, FolderOpen, StickyNote, Check } from 'lucide-react';

// 🆕 V1.5 METADATA EDITOR — tags, folder, note. Organization only; never
// touches the saved tabs themselves. Same dialog motion as ConfirmModal
// (backdrop fade + panel scale-in, CSS-only — test harnesses see the
// fully-rendered dialog on frame 1).
//
// Tags: Enter/comma adds the draft chip, ✕ removes it, exact duplicates are
// ignored while typing. Folder: free text with a datalist of folders already
// in use (no separate folder store — folders ARE the union of session.folder).
export default function SessionMetaModal({
  open, session,
  existingFolders = [],
  onSave, onCancel
}) {
  const [tags, setTags] = useState([]);
  const [draftTag, setDraftTag] = useState('');
  const [folder, setFolder] = useState('');
  const [note, setNote] = useState('');

  // Reset the draft from the session every time the dialog opens
  useEffect(() => {
    if (!open || !session) return;
    setTags(Array.isArray(session.tags) ? [...session.tags] : []);
    setDraftTag('');
    setFolder(session.folder || '');
    setNote(session.note || '');
  }, [open, session]);

  if (!open || !session) return null;

  const addTag = () => {
    const v = draftTag.trim();
    if (!v) return;
    if (!tags.includes(v) && tags.length < 20) setTags([...tags, v]);
    setDraftTag('');
  };

  const commit = () => {
    // The trailing draft (typed but not committed) counts too — a user who
    // types a tag and hits Save expects the tag to be there.
    const finalTags = draftTag.trim() && !tags.includes(draftTag.trim()) && tags.length < 20
      ? [...tags, draftTag.trim()]
      : tags;
    onSave?.({ tags: finalTags, folder: folder.trim() || null, note });
  };

  return (
    // FIXED (not absolute): the card-menu lesson — this dialog mounts inside
    // a scroll container wearing overflow-hidden ancestors; viewport-fixed
    // keeps the backdrop full-bleed and the panel centered at any scroll.
    <div
      className="backdrop-in fixed inset-0 z-40 flex items-center justify-center bg-black/50 dark:bg-black/75 p-5"
      onClick={onCancel}
    >
      <div
        className="dialog-in bg-primary rounded-2xl border border-borderLight/60 shadow-2xl p-4 w-full max-h-[440px] overflow-y-auto custom-scrollbar"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-3">
          <h3 className="font-semibold text-textMain text-sm">Organize session</h3>
          <button onClick={onCancel} title="Close" className="icon-btn text-textMuted hover:text-textMain p-1">
            <X size={15} />
          </button>
        </div>

        {/* ── Tags ── */}
        <div className="mb-3">
          <label className="flex items-center gap-1.5 text-xs font-medium text-textMuted mb-1.5">
            <Tag size={12} /> Tags
          </label>
          {tags.length > 0 && (
            <div className="flex flex-wrap gap-1 mb-1.5">
              {tags.map(t => (
                <span
                  key={t}
                  className="flex items-center gap-1 bg-muted text-textMain text-[11px] px-2 py-0.5 rounded-full border border-borderLight/60"
                >
                  {t}
                  <button
                    onClick={() => setTags(prev => prev.filter(x => x !== t))}
                    title={`Remove tag ${t}`}
                    className="text-textMuted hover:text-red-500"
                  >
                    <X size={10} />
                  </button>
                </span>
              ))}
            </div>
          )}
          <input
            value={draftTag}
            onChange={(e) => setDraftTag(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addTag(); }
              if (e.key === 'Backspace' && !draftTag && tags.length) setTags(prev => prev.slice(0, -1));
            }}
            placeholder={tags.length >= 20 ? 'Tag limit reached' : 'Add a tag, press Enter'}
            disabled={tags.length >= 20}
            className="w-full surface border border-borderLight/60 rounded-lg px-2.5 py-1.5 text-xs text-textMain placeholder:text-textMuted/60 focus:outline-none focus:border-accent/70 transition-colors disabled:opacity-50"
          />
        </div>

        {/* ── Folder ── */}
        <div className="mb-3">
          <label className="flex items-center gap-1.5 text-xs font-medium text-textMuted mb-1.5">
            <FolderOpen size={12} /> Folder
          </label>
          <input
            value={folder}
            onChange={(e) => setFolder(e.target.value)}
            list="orbitabs-folders"
            placeholder="e.g. Work (optional)"
            className="w-full surface border border-borderLight/60 rounded-lg px-2.5 py-1.5 text-xs text-textMain placeholder:text-textMuted/60 focus:outline-none focus:border-accent/70 transition-colors"
          />
          <datalist id="orbitabs-folders">
            {existingFolders.map(f => <option key={f} value={f} />)}
          </datalist>
        </div>

        {/* ── Note ── */}
        <div className="mb-4">
          <label className="flex items-center gap-1.5 text-xs font-medium text-textMuted mb-1.5">
            <StickyNote size={12} /> Note
          </label>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value.slice(0, 500))}
            rows={3}
            placeholder="Why did you save this? (optional)"
            className="w-full surface border border-borderLight/60 rounded-lg px-2.5 py-1.5 text-xs text-textMain placeholder:text-textMuted/60 focus:outline-none focus:border-accent/70 transition-colors resize-none"
          />
          {note.length > 400 && (
            <p className="text-[10px] text-textMuted mt-0.5 text-right">{note.length}/500</p>
          )}
        </div>

        <div className="flex gap-2">
          <button
            onClick={onCancel}
            className="flex-1 px-3 py-2 rounded-lg text-sm font-medium text-textMuted bg-muted hover:bg-borderLight/60 transition-colors flex items-center justify-center gap-1.5"
          >
            <X size={13} /> Cancel
          </button>
          <button
            onClick={commit}
            className="flex-1 px-3 py-2 rounded-lg text-sm font-semibold bg-accent text-accentInk hover:bg-accentDark transition-colors shadow-sm flex items-center justify-center gap-1.5"
          >
            <Check size={13} /> Save
          </button>
        </div>
      </div>
    </div>
  );
}
