import { useState, useCallback } from 'react';
// 🆕 v1 capture lives in the locked schema module — one source of truth for
// the exact shape every save path produces.
import { captureAllWindowsV1 } from '../../services/sessionSchema';

const TAB_GROUP_NONE = -1; // chrome.tabs.TAB_ID_NONE — ungrouped tabs have this groupId

export { captureAllWindowsV1 };

export default function useTabs() {
  const [tabs, setTabs] = useState([]);
  // Group metadata for the CURRENT window (display state only — not saved
  // directly; groups are captured into v1 via captureAllWindowsV1)
  const [groupMeta, setGroupMeta] = useState([]);

  const getCurrentTabs = useCallback(() => {
    if (typeof chrome !== 'undefined' && chrome.tabs) {
      chrome.tabs.query({ currentWindow: true }, (result) => {
        // 🛡️ SAFETY CHECK: Agar result undefined/null hai toh crash nahi hoga
        if (result && Array.isArray(result)) {
          setTabs(result.map(tab => ({
            title: tab.title,
            url: tab.url,
            // 🆕 Keep group membership — needed to rebuild groups on restore
            groupId: typeof tab.groupId === 'number' ? tab.groupId : TAB_GROUP_NONE
          })));

          // 🆕 Capture group info (name, color, collapsed) via tabGroups API
          const hasGroups = result.some(t => t.groupId && t.groupId !== TAB_GROUP_NONE);
          if (hasGroups && chrome.tabGroups?.query) {
            const windowId = result[0]?.windowId;
            chrome.tabGroups.query({ windowId }, (groups) => {
              if (groups && Array.isArray(groups)) {
                setGroupMeta(groups.map(g => ({
                  id: g.id,
                  title: g.title || '',
                  color: g.color || 'grey',
                  collapsed: !!g.collapsed
                })));
              } else {
                setGroupMeta([]);
              }
            });
          } else {
            setGroupMeta([]);
          }
        } else {
          console.warn("Chrome tabs query failed or returned empty.");
          setTabs([]);
          setGroupMeta([]);
        }
      });
    } else {
      // Mock data for development (outside Chrome)
      setTabs([
        { title: "Google", url: "https://google.com", groupId: TAB_GROUP_NONE },
        { title: "YouTube", url: "https://youtube.com", groupId: TAB_GROUP_NONE }
      ]);
      setGroupMeta([]);
    }
  }, []);

  return { tabs, groupMeta, getCurrentTabs };
}