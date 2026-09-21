import React, { useState } from 'react';
import { loginUser, registerUser } from '../../services/api';
import Button from '../components/common/Button';
import Input from '../components/common/Input';
import { Layers, CircleAlert, CheckCircle2 } from 'lucide-react';

export default function Login({ onLogin, onCancel, initialMode = 'login' }) {
  // 🆕 Settings → Account can deep-link straight into "Create account".
  const [isLogin, setIsLogin] = useState(initialMode !== 'register');
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
      if (isLogin) {
        res = await loginUser({ email, password });
        localStorage.setItem('token', res.data.token);
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
      setError(err.response?.data?.error || 'Something went wrong');
    }
  };

  return (
    <div className="w-full h-full bg-gradient-to-b from-primary to-zinc-100/80 dark:from-primary dark:to-secondary/70 p-6 flex flex-col items-center justify-center relative overflow-hidden">
      <div className="absolute top-[-50px] right-[-50px] w-48 h-48 bg-zinc-300 dark:bg-zinc-800 rounded-full blur-3xl opacity-50 dark:opacity-30 pointer-events-none"></div>
      <div className="absolute bottom-[-50px] left-[-50px] w-48 h-48 bg-zinc-200 dark:bg-zinc-900 rounded-full blur-3xl opacity-50 dark:opacity-30 pointer-events-none"></div>

      <div className="relative z-10 flex flex-col items-center w-full max-w-sm">
        <div className="bg-gradient-to-br from-blue-500 to-blue-700 p-4 rounded-2xl shadow-xl shadow-blue-900/40 mb-4 text-white">
          <Layers size={28} />
        </div>
        <h1 className="text-2xl font-bold text-textMain mb-1 tracking-tight">Orbitabs</h1>
        <p className="text-textMuted text-sm mb-6 font-medium">
          {isLogin ? 'Welcome back' : 'Create your account'}
        </p>

        {error && <div className="w-full bg-red-500/10 border border-red-500/30 text-red-600 dark:text-red-400 text-sm p-3 rounded-xl mb-4 text-center flex items-center justify-center gap-1.5"><CircleAlert size={14} className="flex-shrink-0" />{error}</div>}
        {successMsg && <div className="w-full bg-green-50 dark:bg-green-950/40 border border-green-200 dark:border-green-900 text-green-700 dark:text-green-400 text-sm p-3 rounded-xl mb-4 text-center flex items-center justify-center gap-1.5"><CheckCircle2 size={14} className="flex-shrink-0" />{successMsg}</div>}

        <form onSubmit={handleSubmit} className="w-full space-y-4">
          {!isLogin && (
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
          <Input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Password"
          />
          <Button type="submit" className="w-full py-3 text-base mt-2">
            {isLogin ? 'Login' : 'Register'}
          </Button>
        </form>

        <button 
          onClick={() => {
            setIsLogin(!isLogin);
            setError('');
            setSuccessMsg('');
          }} 
          className="mt-5 text-sm text-textMuted hover:text-accent transition-colors underline decoration-2 underline-offset-4 decoration-transparent hover:decoration-accent"
        >
          {isLogin ? "Don't have an account? Register" : "Already have an account? Login"}
        </button>

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