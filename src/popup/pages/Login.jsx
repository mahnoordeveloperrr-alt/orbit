import React, { useState } from 'react';
import { loginUser, registerUser, forgotPassword, saveTokens } from '../../services/api';
import Button from '../components/common/Button';
import Input from '../components/common/Input';
import { CircleAlert, CheckCircle2 } from 'lucide-react';

export default function Login({ onLogin, onCancel, initialMode = 'login' }) {
  // 🆕 Settings → Account can deep-link straight into "Create account".
  const [isLogin, setIsLogin] = useState(initialMode !== 'register');
  // 🔑 view: 'form' = login/register, 'forgot' = password recovery.
  const [view, setView] = useState('form');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [successMsg, setSuccessMsg] = useState(''); // 🆕 Success message

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setSuccessMsg('');

    try {
      let res;
      if (view === 'forgot') {
        // 🔑 Server always answers generically (no account enumeration) and
        //    emails a single-use 30-minute reset link on a real account.
        res = await forgotPassword(email);
        setSuccessMsg(res.data.message || 'If that email has an account, a reset link is on its way.');
        return;
      }
      if (isLogin) {
        res = await loginUser({ email, password });
        // 🔑 Store the pair: access JWT + per-device rotating refresh token
        //    (mirrored into chrome.storage.local for the service worker).
        saveTokens({ token: res.data.token, refreshToken: res.data.refreshToken });
        onLogin(true); // Login ho gaya
      } else {
        res = await registerUser({ name, email, password });
        // 🔥 Register par token nahi aaya, direct message aaya
        if (res.data.needsVerification) {
          setSuccessMsg(res.data.message);
          setEmail('');
          setPassword('');
          setName('');
          setIsLogin(true); // Wapas Login mode mein le jao
        }
      }
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'Something went wrong');
    }
  };

  return (
    <div className="w-full h-full bg-primary p-6 flex flex-col items-center justify-center relative overflow-hidden">
      <div className="relative z-10 flex flex-col items-center w-full max-w-sm">
        <img
          src="/brand/orbitabs-wordmark.png"
          alt="Orbitabs"
          className="h-12 w-48 object-contain mb-2 dark:invert-0 invert"
        />
        <p className="text-textMuted text-sm mb-6 font-medium">
          {view === 'forgot' ? 'Reset your password' : isLogin ? 'Welcome back' : 'Create your account'}
        </p>

        {error && <div className="w-full bg-red-500/10 border border-red-500/30 text-red-600 dark:text-red-400 text-sm p-3 rounded-xl mb-4 text-center flex items-center justify-center gap-1.5"><CircleAlert size={14} className="flex-shrink-0" />{error}</div>}
        {successMsg && <div className="w-full bg-green-50 dark:bg-green-950/40 border border-green-200 dark:border-green-900 text-green-700 dark:text-green-400 text-sm p-3 rounded-xl mb-4 text-center flex items-center justify-center gap-1.5"><CheckCircle2 size={14} className="flex-shrink-0" />{successMsg}</div>}

        <form onSubmit={handleSubmit} className="w-full space-y-4">
          {view === 'form' && !isLogin && (
            <Input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Full Name"
            />
          )}
          <Input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="Email"
          />
          {view === 'form' && (
            <Input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Password"
            />
          )}
          <Button type="submit" className="w-full py-3 text-base mt-2">
            {view === 'forgot' ? 'Send reset link' : isLogin ? 'Login' : 'Register'}
          </Button>
        </form>

        {view === 'form' && (
          <button
            onClick={() => {
              setIsLogin(!isLogin);
              setError('');
              setSuccessMsg('');
            }}
            className="mt-5 text-sm text-textMuted hover:text-textMain transition-colors underline decoration-2 underline-offset-4 decoration-transparent hover:decoration-accent"
          >
            {isLogin ? "Don't have an account? Register" : "Already have an account? Login"}
          </button>
        )}

        {/* 🔑 Password recovery — link only makes sense on the login form */}
        {view === 'form' && isLogin && (
          <button
            onClick={() => {
              setView('forgot');
              setError('');
              setSuccessMsg('');
              setPassword('');
            }}
            className="mt-2 text-sm text-textMuted hover:text-textMain transition-colors"
          >
            Forgot password?
          </button>
        )}
        {view === 'forgot' && (
          <button
            onClick={() => {
              setView('form');
              setError('');
              setSuccessMsg('');
            }}
            className="mt-5 text-sm text-textMuted hover:text-textMain transition-colors underline decoration-2 underline-offset-4 decoration-transparent hover:decoration-accent"
          >
            ← Back to login
          </button>
        )}

        {/* 🆕 MANDATORY-ACCOUNT RULE: signing in is never required to use the app */}
        {onCancel && (
          <button
            onClick={onCancel}
            className="mt-2 text-sm text-textMuted hover:text-textMain transition-colors font-medium"
          >
            Continue without account →
          </button>
        )}
      </div>
    </div>
  );
}
