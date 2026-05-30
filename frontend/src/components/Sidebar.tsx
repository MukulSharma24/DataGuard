'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useState } from 'react';
import { cn } from '@/lib/utils';
import {
  LayoutDashboard, Database, Settings2, ScanLine,
  BookOpen, Map, ScrollText, ShieldCheck, ChevronLeft, LogOut
} from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { logout as apiLogout } from '@/lib/api';

const NAV = [
  { href: '/',          icon: LayoutDashboard, label: 'Overview' },
  { href: '/sources',   icon: Database,        label: 'Data Sources' },
  { href: '/profiles',  icon: Settings2,       label: 'Scan Profiles' },
  { href: '/scans',     icon: ScanLine,        label: 'Scan Runs' },
  { href: '/catalogue', icon: BookOpen,        label: 'Data Catalogue' },
  { href: '/map',       icon: Map,             label: 'Data Map' },
  { href: '/logs',      icon: ScrollText,      label: 'Logs' },
];

export function Sidebar() {
  const pathname  = usePathname();
  const router    = useRouter();
  const { user, setUser } = useAuth();
  const [collapsed, setCollapsed] = useState(false);

  async function handleLogout() {
    await apiLogout().catch(() => {});
    setUser(null);
    router.replace('/login');
  }

  const initials = user?.email
    ? user.email.slice(0, 2).toUpperCase()
    : '??';

  return (
    <aside
      className={cn(
        'sticky top-0 h-screen shrink-0 flex flex-col',
        'bg-[#0d1117] text-white',
        'border-r border-white/[0.06]',
        'transition-all duration-300 ease-in-out overflow-hidden',
        collapsed ? 'w-[60px]' : 'w-[220px]'
      )}
    >
      {/* Logo */}
      <div className={cn(
        'flex items-center shrink-0 h-14',
        'border-b border-white/[0.06]',
        collapsed ? 'justify-center' : 'px-4 gap-2.5'
      )}>
        <div className="w-8 h-8 rounded-lg bg-indigo-500 flex items-center justify-center shrink-0 shadow-lg shadow-indigo-600/30">
          <ShieldCheck size={16} className="text-white" />
        </div>
        {!collapsed && (
          <div className="overflow-hidden min-w-0">
            <div className="text-[13px] font-bold text-white tracking-wide leading-tight whitespace-nowrap">
              DataGuard
            </div>
            <div className="text-[10px] text-slate-600 leading-tight whitespace-nowrap mt-0.5">
              Data Lifecycle
            </div>
          </div>
        )}
      </div>

      {/* Nav */}
      <nav className="flex-1 px-2 py-3 space-y-0.5 overflow-y-auto overflow-x-hidden scrollbar-thin">
        {NAV.map(({ href, icon: Icon, label }) => {
          const active = href === '/' ? pathname === '/' : pathname.startsWith(href);
          return (
            <Link
              key={href}
              href={href}
              title={collapsed ? label : undefined}
              className={cn(
                'relative flex items-center rounded-lg text-[13px] font-medium',
                'transition-all duration-150',
                collapsed ? 'justify-center py-2.5' : 'gap-2.5 px-3 py-2.5',
                active
                  ? 'bg-indigo-500/15 text-indigo-300'
                  : 'text-slate-500 hover:text-slate-200 hover:bg-white/[0.05]'
              )}
            >
              {/* Active left indicator */}
              {active && !collapsed && (
                <span className="absolute left-0 top-1/2 -translate-y-1/2 w-0.5 h-4 bg-indigo-400 rounded-r-full" />
              )}
              <Icon
                size={15}
                className={cn('shrink-0 transition-colors', active ? 'text-indigo-400' : 'text-slate-600')}
              />
              {!collapsed && (
                <span className="whitespace-nowrap overflow-hidden">{label}</span>
              )}
            </Link>
          );
        })}
      </nav>

      {/* User section */}
      {user && (
        <div className={cn(
          'border-t border-white/[0.06] shrink-0',
          collapsed ? 'p-2' : 'px-3 py-3'
        )}>
          {collapsed ? (
            <button
              onClick={handleLogout}
              title={`Logout (${user.email})`}
              className="w-full flex justify-center p-1.5 rounded-lg text-slate-600 hover:text-rose-400 hover:bg-white/[0.05] transition-colors"
            >
              <LogOut size={14} />
            </button>
          ) : (
            <div className="flex items-center gap-2.5">
              <div className="w-7 h-7 rounded-full bg-indigo-500/20 border border-indigo-500/30 flex items-center justify-center shrink-0">
                <span className="text-[10px] font-bold text-indigo-300">{initials}</span>
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-[11px] font-medium text-slate-300 truncate leading-tight">{user.email}</p>
                <p className={cn(
                  'text-[10px] font-semibold uppercase tracking-wider leading-tight mt-0.5',
                  user.role === 'admin' ? 'text-indigo-500' : 'text-slate-600'
                )}>
                  {user.role}
                </p>
              </div>
              <button
                onClick={handleLogout}
                title="Sign out"
                className="shrink-0 p-1.5 rounded-lg text-slate-600 hover:text-rose-400 hover:bg-white/[0.05] transition-colors"
              >
                <LogOut size={13} />
              </button>
            </div>
          )}
        </div>
      )}

      {/* Footer + collapse */}
      <div className={cn(
        'border-t border-white/[0.06] shrink-0 flex items-center',
        collapsed ? 'justify-center py-3' : 'px-4 py-2.5 justify-between'
      )}>
        {!collapsed && (
          <p className="text-[10px] text-slate-700 font-medium">v1.0.0</p>
        )}
        <button
          onClick={() => setCollapsed(c => !c)}
          className="text-slate-700 hover:text-slate-300 transition-colors p-1 rounded-md hover:bg-white/[0.05]"
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          <ChevronLeft
            size={14}
            className={cn('transition-transform duration-300', collapsed && 'rotate-180')}
          />
        </button>
      </div>
    </aside>
  );
}
