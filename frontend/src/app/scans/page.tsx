'use client';

import { useEffect, useState, useCallback } from 'react';
import { getScans } from '@/lib/api';
import { formatDate, STATUS_COLOURS } from '@/lib/utils';
import { Badge } from '@/components/ui/Badge';
import { Card, CardHeader } from '@/components/ui/Card';
import { SkeletonRow } from '@/components/ui/Skeleton';
import Link from 'next/link';
import { ScanLine, RefreshCw, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/Button';

const STATUSES = ['', 'running', 'completed', 'partial', 'failed', 'pending'];

export default function ScansPage() {
  const [scans, setScans]         = useState<any[]>([]);
  const [loading, setLoading]     = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [filter, setFilter]       = useState('');

  const load = useCallback((manual = false) => {
    if (manual) setRefreshing(true); else setLoading(true);
    const params: any = { limit: '100' };
    if (filter) params.status = filter;
    getScans(params)
      .then(r => setScans(r.scans ?? []))
      .finally(() => { setLoading(false); setRefreshing(false); });
  }, [filter]);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="p-8 space-y-6 animate-fadeIn">
      {/* Header */}
      <div className="flex items-center justify-between pb-5 border-b border-slate-100">
        <div>
          <h1 className="text-[22px] font-bold text-slate-900 tracking-tight">Scan Runs</h1>
          <p className="text-sm text-slate-500 mt-1">History of all scan executions</p>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={filter}
            onChange={e => setFilter(e.target.value)}
            className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-700 focus:outline-none focus:ring-2 focus:ring-indigo-500/30 focus:border-indigo-400 transition-colors"
          >
            {STATUSES.map(s => (
              <option key={s} value={s}>{s || 'All statuses'}</option>
            ))}
          </select>
          <Button variant="secondary" size="sm" onClick={() => load(true)} disabled={refreshing || loading} title="Refresh">
            <RefreshCw size={13} className={refreshing ? 'animate-spin' : ''} />
          </Button>
        </div>
      </div>

      {/* Content */}
      {loading ? (
        <Card>
          <div className="px-5 py-3 border-b border-slate-100">
            <div className="h-3.5 w-24 skeleton rounded" />
          </div>
          {Array.from({ length: 6 }).map((_, i) => <SkeletonRow key={i} />)}
        </Card>
      ) : scans.length === 0 ? (
        <Card>
          <div className="flex flex-col items-center py-16 gap-3">
            <div className="w-12 h-12 rounded-xl bg-slate-100 flex items-center justify-center">
              <ScanLine size={22} className="text-slate-400" />
            </div>
            <div className="text-center">
              <p className="font-semibold text-slate-700">No scan runs found</p>
              <p className="text-sm text-slate-400 mt-1">
                Go to{' '}
                <Link href="/profiles" className="text-indigo-600 hover:underline font-medium">
                  Scan Profiles
                </Link>
                {' '}and click &ldquo;Run Scan&rdquo; to start.
              </p>
            </div>
          </div>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <p className="text-xs font-medium text-slate-500 tabular-nums">
              {scans.length} scan run{scans.length !== 1 ? 's' : ''}
            </p>
          </CardHeader>
          <div className="divide-y divide-slate-50">
            {scans.map(scan => (
              <Link
                key={scan.id}
                href={`/scans/${scan.id}`}
                className="flex items-center gap-3 px-5 py-4 hover:bg-slate-50/70 transition-colors group border-l-2 border-transparent hover:border-l-indigo-200"
              >
                <div className={`w-2 h-2 rounded-full shrink-0 ${
                  scan.status === 'completed' ? 'bg-emerald-500' :
                  scan.status === 'running'   ? 'bg-blue-500 animate-pulse' :
                  scan.status === 'failed'    ? 'bg-rose-500' :
                  scan.status === 'partial'   ? 'bg-amber-500' :
                  scan.status === 'cancelled' ? 'bg-slate-400' : 'bg-slate-300'
                }`} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="font-semibold text-slate-900 text-sm group-hover:text-indigo-700 transition-colors truncate">
                      {scan.source_name}
                    </p>
                    <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded uppercase tracking-wide shrink-0 ${
                      scan.source_type === 'postgresql' ? 'bg-blue-50 text-blue-700' : 'bg-emerald-50 text-emerald-700'
                    }`}>
                      {scan.source_type === 'postgresql' ? 'PG' : 'MDB'}
                    </span>
                  </div>
                  <p className="text-xs text-slate-400 mt-0.5 truncate">
                    {scan.profile_name} · {formatDate(scan.started_at)}
                  </p>
                </div>
                <div className="flex items-center gap-4 ml-4 shrink-0">
                  <div className="text-right hidden sm:block">
                    <p className="text-sm font-semibold text-slate-800 tabular-nums">
                      {scan.tables_scanned ?? 0}
                    </p>
                    <p className="text-[10px] text-slate-400 uppercase tracking-wide">tables</p>
                  </div>
                  <div className="text-right hidden sm:block">
                    <p className="text-sm font-semibold text-slate-800 tabular-nums">
                      {scan.findings_count ?? 0}
                    </p>
                    <p className="text-[10px] text-slate-400 uppercase tracking-wide">findings</p>
                  </div>
                  <Badge
                    label={scan.status}
                    className={STATUS_COLOURS[scan.status] ?? ''}
                    size="sm"
                    dot
                  />
                  <ChevronRight size={14} className="text-slate-300 group-hover:text-slate-400 transition-colors" />
                </div>
              </Link>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}
