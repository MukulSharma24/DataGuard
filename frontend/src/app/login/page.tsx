'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ShieldCheck, Eye, EyeOff, ArrowRight } from 'lucide-react';
import { login } from '@/lib/api';
import { useAuth } from '@/contexts/AuthContext';

export default function LoginPage() {
  const [email, setEmail]       = useState('');
  const [password, setPassword] = useState('');
  const [showPw, setShowPw]     = useState(false);
  const [error, setError]       = useState('');
  const [loading, setLoading]   = useState(false);
  const router   = useRouter();
  const { setUser } = useAuth();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const data = await login({ email, password });
      setUser(data.user);
      router.replace('/');
    } catch (err: any) {
      setError(err.message || 'Login failed');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-[#070d1a] flex items-center justify-center p-4 relative overflow-hidden">
      {/* Subtle grid */}
      <div
        className="absolute inset-0 opacity-[0.025]"
        style={{
          backgroundImage:
            'linear-gradient(rgba(165,180,252,1) 1px, transparent 1px), linear-gradient(90deg, rgba(165,180,252,1) 1px, transparent 1px)',
          backgroundSize: '48px 48px',
        }}
      />
      {/* Radial glow */}
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_70%_40%_at_50%_-10%,rgba(99,102,241,0.12),transparent)]" />
      {/* Bottom fade */}
      <div className="absolute bottom-0 left-0 right-0 h-32 bg-gradient-to-t from-[#070d1a] to-transparent" />

      <div className="relative w-full max-w-[360px] animate-slideUp">
        {/* Logo */}
        <div className="flex items-center justify-center gap-3 mb-9">
          <div className="w-10 h-10 rounded-xl bg-indigo-500 flex items-center justify-center shadow-2xl shadow-indigo-600/40">
            <ShieldCheck size={20} className="text-white" />
          </div>
          <div>
            <div className="text-white font-bold text-[18px] tracking-tight leading-tight">DataGuard</div>
            <div className="text-slate-600 text-[11px] leading-tight mt-0.5">Data Lifecycle Management</div>
          </div>
        </div>

        {/* Card */}
        <div className="bg-[#0f1729] rounded-2xl border border-white/[0.08] shadow-2xl shadow-black/60 p-7">
          <div className="mb-6">
            <h1 className="text-white text-[18px] font-semibold tracking-tight leading-tight">
              Welcome back
            </h1>
            <p className="text-slate-500 text-sm mt-1.5 leading-relaxed">
              Sign in to your workspace
            </p>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-[11px] font-semibold text-slate-500 uppercase tracking-wide mb-1.5">
                Email address
              </label>
              <input
                type="email"
                autoComplete="email"
                value={email}
                onChange={e => setEmail(e.target.value)}
                required
                className="w-full bg-white/[0.04] border border-white/[0.1] rounded-lg px-3.5 py-2.5 text-white placeholder-slate-600 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/50 focus:border-indigo-500/50 transition-all"
                placeholder="admin@example.com"
              />
            </div>

            <div>
              <label className="block text-[11px] font-semibold text-slate-500 uppercase tracking-wide mb-1.5">
                Password
              </label>
              <div className="relative">
                <input
                  type={showPw ? 'text' : 'password'}
                  autoComplete="current-password"
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  required
                  className="w-full bg-white/[0.04] border border-white/[0.1] rounded-lg px-3.5 py-2.5 pr-11 text-white placeholder-slate-600 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/50 focus:border-indigo-500/50 transition-all"
                  placeholder="••••••••"
                />
                <button
                  type="button"
                  onClick={() => setShowPw(s => !s)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-600 hover:text-slate-400 transition-colors p-1"
                  tabIndex={-1}
                >
                  {showPw ? <EyeOff size={14} /> : <Eye size={14} />}
                </button>
              </div>
            </div>

            {error && (
              <div className="flex items-center gap-2.5 bg-rose-500/10 border border-rose-500/20 rounded-lg px-3.5 py-2.5">
                <div className="w-1.5 h-1.5 rounded-full bg-rose-400 shrink-0" />
                <p className="text-rose-400 text-sm">{error}</p>
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full mt-1 bg-indigo-600 hover:bg-indigo-500 active:bg-indigo-700 disabled:opacity-60 disabled:cursor-not-allowed text-white font-semibold rounded-lg py-2.5 text-sm transition-all shadow-lg shadow-indigo-600/25 flex items-center justify-center gap-2"
            >
              {loading ? (
                <>
                  <div className="w-4 h-4 border-2 border-white/25 border-t-white rounded-full animate-spin" />
                  <span>Signing in…</span>
                </>
              ) : (
                <>
                  <span>Sign in</span>
                  <ArrowRight size={15} />
                </>
              )}
            </button>
          </form>
        </div>

        <p className="text-center text-slate-700 text-[11px] mt-5 leading-relaxed">
          First time?{' '}
          <span className="text-slate-600">
            POST to{' '}
            <code className="bg-white/[0.05] text-slate-400 px-1.5 py-0.5 rounded-md font-mono text-[10px]">
              /api/auth/register
            </code>
            {' '}to create an admin account
          </span>
        </p>
      </div>
    </div>
  );
}
