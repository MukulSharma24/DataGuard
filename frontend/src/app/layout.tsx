import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import './globals.css';
import { AuthProvider } from '@/contexts/AuthContext';
import { LayoutShell } from '@/components/LayoutShell';

const inter = Inter({ subsets: ['latin'] });

export const metadata: Metadata = {
  title: 'DataGuard — Data Lifecycle Management',
  description: 'Discover, classify, and govern PII across your data sources',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className={`${inter.className} bg-slate-50 antialiased`}>
        <AuthProvider>
          <LayoutShell>
            {children}
          </LayoutShell>
        </AuthProvider>
      </body>
    </html>
  );
}
