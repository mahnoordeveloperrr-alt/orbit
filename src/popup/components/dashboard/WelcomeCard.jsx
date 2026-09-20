import React, { useState, useEffect } from 'react';
import { X } from 'lucide-react';

/**
 * 🆕 First-run welcome — shows ONCE (flag in chrome.storage.local, mirrored to
 * localStorage so the popup renders it before the storage round-trip).
 * No long onboarding: one card, one CTA, one honest line about where data lives.
 */
const KEY = 'orbi_welcomed';

export default function WelcomeCard({ onQuickSave }) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    // localStorage is unavailable in some host contexts (tests, dev previews)
    // — the chrome.storage flag alone must be enough to stay dismissed.
    if (typeof localStorage !== 'undefined' && localStorage.getItem(KEY)) return; // fast path
    if (typeof chrome === 'undefined' || !chrome.storage?.local) return;
    chrome.storage.local.get([KEY]).then(({ [KEY]: seen }) => {
      if (!seen) setVisible(true);
    }).catch(() => {});
  }, []);

  const dismiss = () => {
    setVisible(false);
    if (typeof localStorage !== 'undefined') localStorage.setItem(KEY, '1');
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      chrome.storage.local.set({ [KEY]: Date.now() }).catch(() => {});
    }
  };

  const handleSave = () => {
    dismiss();
    onQuickSave?.();
  };

  if (!visible) return null;

  return (
    <div className="relative z-10 mb-2 rounded-[14px] border border-violet-200 bg-violet-50/90 dark:bg-secondary p-3.5">
      <button
        onClick={dismiss}
        title="Don't show again"
        className="absolute top-1.5 right-1.5 p-1 text-textMuted hover:text-textMain transition-colors"
      >
        <X size={13} />
      </button>
      <p className="text-sm font-bold text-textMain">Welcome to Orbitabs</p>
      <p className="text-xs text-textMuted mt-1 leading-relaxed">
        Save your Chrome tabs, groups and windows — and restore them whenever you need.
      </p>
      <button
        onClick={handleSave}
        className="mt-2.5 w-full bg-accent hover:bg-violet-700 text-onAccent text-sm font-semibold px-3 py-2 rounded-[10px] transition-colors"
      >
        Save My Current Tabs
      </button>
      <p className="text-[11px] text-textMuted mt-2 leading-relaxed">
        Orbitabs stores your sessions locally by default. No account required.
      </p>
    </div>
  );
}
