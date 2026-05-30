'use client';

import { usePathname } from 'next/navigation';
import { Sidebar } from '@/components/Sidebar';

export function LayoutShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  if (pathname === '/login') {
    return <>{children}</>;
  }

  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar />
      <main className="flex-1 overflow-y-auto transition-all duration-300 ease-in-out">
        {children}
      </main>
    </div>
  );
}
