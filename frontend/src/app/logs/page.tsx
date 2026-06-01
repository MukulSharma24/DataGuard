'use client';

import { useEffect, useState } from 'react';
import { getScans, getSources, testSource } from '@/lib/api';
import { formatDate, STATUS_COLOURS } from '@/lib/utils';
import { Badge } from '@/components/ui/Badge';
import { Card, CardHeader, CardBody } from '@/components/ui/Card';
import { SkeletonRow, Skeleton } from '@/components/ui/Skeleton';
import { Button } from '@/components/ui/Button';
import {
  ScrollText, RefreshCw, TestTube2,
  CheckCircle2, XCircle, AlertTriangle, X
} from 'lucide-react';

export default function LogsPage() {
  const [scans, setScans]           = useState<any[]>([]);
  const [sources, setSources]       = useState<any[]>([]);
  const [loading, setLoading]       = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [selected, setSelected]     = useState<any>(null);
  const [testResults, setTestResults] = useState<Record<string, any>>({});
  const [testing, setTesting]       = useState<string | null>(null);

  async function load(manual = false) {
    if (manual) setRefreshing(true); else setLoading(true);
    try {
      const [sc, sr] = await Promise.all([getScans({ limit: '50' }), getSources()]);
      setScans(sc.scans ?? []);
      setSources(sr.sources ?? []);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }

  useEffect(() => { load(); }, []);

  async function handleTest(id: string) {
    setTesting(id);
    try {
      const r = await testSource(id);
      setTestResults(prev => ({ ...prev, [id]: r }));
    } finally {
      setTesting(null);
    }
  }

  const failedScans  = scans.filter(s => s.status === 'failed');
  const partialScans = scans.filter(s => s.status === 'partial');

  return (
    <div className="p-8 space-y-6 animate-fadeIn">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-[22px] font-bold text-slate-900 tracking-tight">Logs</h1>
          <p className="text-sm text-slate-500 mt-1">
            Connection tests, scan errors, and operational history
          </p>
        </div>
        <Button variant="secondary" size="sm" onClick={() => load(true)} disabled={refreshing || loading}>
          <RefreshCw size={13} className={refreshing ? 'animate-spin' : ''} /> Refresh
        </Button>
      </div>

      {/* Connection test panel */}
      <Card>
        <CardHeader>
          <h2 className="text-sm font-semibold text-slate-900">Connection Tests</h2>
        </CardHeader>
        <div className="divide-y divide-slate-50">
          {loading ? (
            Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="flex items-center justify-between px-5 py-3.5">
                <div className="space-y-2 flex-1">
                  <Skeleton className="h-3.5 w-1/4" />
                  <Skeleton className="h-3 w-1/3" />
                </div>
                <div className="flex gap-2">
                  <Skeleton className="h-5 w-16 rounded-full" />
                  <Skeleton className="h-7 w-16 rounded-lg" />
                </div>
              </div>
            ))
          ) : sources.length === 0 ? (
            <p className="px-5 py-8 text-sm text-slate-400 text-center">
              No data sources configured.
            </p>
          ) : sources.map(src => {
            const tr = testResults[src.id];
            return (
              <div key={src.id} className="flex items-center justify-between px-5 py-3.5 hover:bg-slate-50/70 transition-colors">
                <div>
                  <p className="text-sm font-semibold text-slate-800">{src.name}</p>
                  <p className="text-xs text-slate-400 mt-0.5 capitalize">
                    {src.type} · Last scanned: {formatDate(src.last_scanned)}
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  {tr && (
                    <span className={`text-xs flex items-center gap-1.5 font-medium ${
                      tr.success ? 'text-emerald-600' : 'text-rose-500'
                    }`}>
                      {tr.success
                        ? <><CheckCircle2 size={13} /> {tr.latencyMs}ms</>
                        : <><XCircle size={13} /> {tr.error}</>
                      }
                    </span>
                  )}
                  <Badge label={src.status} className={STATUS_COLOURS[src.status] ?? ''} size="sm" dot />
                  <Button
                    variant="secondary"
                    size="sm"
                    loading={testing === src.id}
                    onClick={() => handleTest(src.id)}
                  >
                    <TestTube2 size={12} /> Test
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      </Card>

      {/* Scan issues */}
      {(failedScans.length > 0 || partialScans.length > 0) && (
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <AlertTriangle size={15} className="text-amber-500" />
              <h2 className="text-sm font-semibold text-slate-900">Scan Issues</h2>
              <span className="text-xs text-slate-400 font-medium">
                {failedScans.length} failed · {partialScans.length} partial
              </span>
            </div>
          </CardHeader>
          <div className="divide-y divide-slate-50">
            {[...failedScans, ...partialScans].map(scan => (
              <button
                key={scan.id}
                className="w-full flex items-start justify-between px-5 py-4 hover:bg-slate-50 text-left transition-colors"
                onClick={() => setSelected(selected?.id === scan.id ? null : scan)}
              >
                <div>
                  <p className="text-sm font-semibold text-slate-800">{scan.source_name}</p>
                  <p className="text-xs text-slate-400 mt-0.5">
                    {scan.profile_name} · {formatDate(scan.started_at)}
                  </p>
                  {scan.error_message && (
                    <p className="text-xs text-rose-500 mt-1.5 font-medium">{scan.error_message}</p>
                  )}
                </div>
                <Badge
                  label={scan.status}
                  className={STATUS_COLOURS[scan.status] ?? ''}
                  size="sm"
                  dot
                />
              </button>
            ))}
          </div>
        </Card>
      )}

      {/* Log viewer */}
      {selected && (
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-sm font-semibold text-slate-900">
                  {selected.source_name}
                  <span className="text-slate-400 font-normal ml-2">— {selected.profile_name}</span>
                </h2>
              </div>
              <button
                onClick={() => setSelected(null)}
                className="p-1.5 rounded-lg text-slate-400 hover:text-slate-600 hover:bg-slate-100 transition-colors"
              >
                <X size={14} />
              </button>
            </div>
          </CardHeader>
          <div className="bg-[#0d1117] rounded-b-xl p-4 h-64 overflow-y-auto scrollbar-thin">
            <pre className="text-xs text-emerald-400 font-mono whitespace-pre-wrap leading-[1.7]">
              {selected.log || '// No log available'}
            </pre>
          </div>
        </Card>
      )}

      {/* Scan history */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold text-slate-900">Scan History</h2>
            {!loading && (
              <span className="text-xs text-slate-400 font-medium tabular-nums">
                {scans.length} run{scans.length !== 1 ? 's' : ''}
              </span>
            )}
          </div>
        </CardHeader>
        <div className="divide-y divide-slate-50">
          {loading ? (
            Array.from({ length: 5 }).map((_, i) => <SkeletonRow key={i} />)
          ) : scans.length === 0 ? (
            <div className="flex flex-col items-center py-12 gap-2">
              <div className="w-10 h-10 rounded-xl bg-slate-100 flex items-center justify-center">
                <ScrollText size={18} className="text-slate-400" />
              </div>
              <p className="text-sm text-slate-400 font-medium">No scan history yet.</p>
            </div>
          ) : scans.map(scan => (
            <div key={scan.id} className="flex items-center justify-between px-5 py-3.5 hover:bg-slate-50/70 transition-colors">
              <div>
                <p className="text-sm font-semibold text-slate-800">{scan.source_name}</p>
                <p className="text-xs text-slate-400 mt-0.5">{formatDate(scan.started_at)}</p>
              </div>
              <div className="flex items-center gap-3">
                <span className="text-xs text-slate-400 tabular-nums">
                  {scan.tables_scanned} tables · {scan.findings_count} findings
                </span>
                <Badge label={scan.status} className={STATUS_COLOURS[scan.status] ?? ''} size="sm" dot />
              </div>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
