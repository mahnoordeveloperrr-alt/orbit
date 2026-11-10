import React, { useState, useEffect } from 'react';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';

// 🆕 Mirror the auth token PAIR into chrome.storage.local — the background
// service worker CANNOT read the popup's localStorage, but it needs both the
// token and the refresh token (sliding session) for cloud sync.
const mirrorToken = (token) => {
  if (typeof chrome !== 'undefined' && chrome.storage?.local) {
    const rt = localStorage.getItem('refreshToken');
    if (token) chrome.storage.local.set(rt ? { token, refreshToken: rt } : { token });
    else chrome.storage.local.remove(['token', 'refreshToken']);
  }
};

// theme (light/dark only — system mode removed) lives in ./hooks/useTheme — shared, not exported
// from this component file.
import useTheme from './hooks/useTheme';

function App() {
  const { theme, cycleTheme } = useTheme();
  // 🆕 LOCAL-FIRST: no login gate. The dashboard (and every feature) works
  // without an account; signing in is an optional cloud-sync layer.
  const [view, setView] = useState('dashboard'); // 'dashboard' | 'login'
  const [loginMode, setLoginMode] = useState('login'); // 'login' | 'register'
  const [cloudUser, setCloudUser] = useState(null);

  useEffect(() => {
    const token = localStorage.getItem('token');
    if (token) {
      setCloudUser(true);
      mirrorToken(token);
    }
  }, []);

  const handleLogout = () => {
    localStorage.removeItem('token');
    localStorage.removeItem('refreshToken');
    mirrorToken(null);
    setCloudUser(null);
    setView('dashboard'); // sign-out never kicks you out of the app
  };

  return (
    /* w-full/h-full: the shell MUST track #root's fixed 420×560 box
       (index.html). A hardcoded height LARGER than the root (this used to be
       h-[640px]) got sliced off by the root's overflow:hidden — the bottom
       ~80px of the popup (Trash, end of the list) was unreachable because
       neither layer scrolls. The shell follows the root; the pages inside
       own their own scrolling. */
    <div className="w-full h-full rounded-2xl border border-borderLight/60 overflow-hidden bg-primary">
      {/* rounded shell; the PAGE paints the theme (index.css base layer —
          blue gradient + glow), and it stays visible through the shell so
          glass cards have something luminous behind their blur. No opaque
          shell fill: that would flatten the glass effect back to solid.
          (In light mode the shell itself carries a light gradient so cards
          keep a tinted backdrop even without the html gradient.) */}
      {view === 'login' ? (
        <Login
          initialMode={loginMode}
          onLogin={() => {
            mirrorToken(localStorage.getItem('token'));
            setCloudUser(true);
            setView('dashboard');
          }}
          onCancel={() => setView('dashboard')} // 🆕 escape hatch back to the app
        />
      ) : (
        <Dashboard
          cloudUser={cloudUser}
          theme={theme}
          onCycleTheme={cycleTheme}
          onOpenLogin={(mode) => { setLoginMode(mode === 'register' ? 'register' : 'login'); setView('login'); }}
          onLogout={handleLogout}
        />
      )}
    </div>
  );
}

export default App;
