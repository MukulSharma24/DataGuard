'use client';

import { useEffect, useState } from 'react';
import { getCatalogueStats, getScans, getCatalogueByCategory } from '@/lib/api';
import { formatDate, STATUS_COLOURS, PII_CATEGORY_COLOURS } from '@/lib/utils';
import { Badge } from '@/components/ui/Badge';
import { Card, CardHeader, CardBody } from '@/components/ui/Card';
import { SkeletonStatCard, SkeletonRow, Skeleton } from '@/components/ui/Skeleton';
import Link from 'next/link';
import {
  Database, ScanLine, ShieldAlert, CheckCircle2,
  Clock, TrendingUp, AlertCircle, ArrowRight
} from 'lucide-react';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip,
  ResponsiveContainer, Cell
} from 'recharts';

const BAR_COLOURS = [
  '#6366f1','#8b5cf6','#ec4899','#f59e0b','#10b981',
  '#14b8a6','#f43f5e','#3b82f6','#84cc16','#06b6d4','#a855f7',
];

function StatCard({ label, value, icon: Icon, bg, fg }: {
  label: string; value: any; icon: any; bg: string; fg: string;
}) {
  return (
    <Card className="hover:shadow-card-md transition-shadow duration-200">
      <CardBody className="p-5">
        <div className={`w-9 h-9 rounded-lg flex items-center justify-center mb-4 ${bg}`}>
          <Icon size={16} className={fg} />
        </div>
        <p className="text-2xl font-bold text-slate-900 tabular-nums tracking-tight leading-none">
          {value ?? '—'}
        </p>
        <p className="text-xs text-slate-500 mt-2 font-medium leading-tight">{label}</p>
      </CardBody>
    </Card>
  );
}

export default function OverviewPage() {
  const [stats, setStats]     = useState<any>(null);
  const [scans, setScans]     = useState<any[]>([]);
  const [catData, setCatData] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState<string | null>(null);

  useEffect(() => {
    Promise.all([
      getCatalogueStats(),
      getScans({ limit: '8' }),
      getCatalogueByCategory(),
    ])
      .then(([s, sc, cat]) => {
        setStats(s.stats ?? null);
        setScans(sc.scans ?? []);
        setCatData(cat.byCategory ?? []);
      })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  if (error) return (
    <div className="p-8">
      <div className="rounded-xl border border-rose-200 bg-rose-50 p-5 flex gap-3">
        <AlertCircle size={18} className="mt-0.5 shrink-0 text-rose-500" />
        <div>
          <p className="font-semibold text-rose-800 text-sm">Could not load dashboard</p>
          <p className="text-sm text-rose-600 mt-1">{error}</p>
          <p className="text-sm text-rose-500 mt-0.5">Make sure the backend is running on port 4000.</p>
        </div>
      </div>
    </div>
  );

  return (
    <div className="p-8 space-y-8 animate-fadeIn">
      {/* Page header */}
      <div>
        <h1 className="text-[22px] font-bold text-slate-900 tracking-tight">Overview</h1>
        <p className="text-sm text-slate-500 mt-1">Your data privacy posture at a glance</p>
      </div>

      {/* Stats grid */}
      <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-4">
        {loading ? (
          Array.from({ length: 6 }).map((_, i) => <SkeletonStatCard key={i} />)
        ) : (
          <>
            <StatCard label="Data Sources"      value={stats?.total_sources}       icon={Database}     bg="bg-indigo-50"  fg="text-indigo-600" />
            <StatCard label="Scans Run"         value={stats?.total_scans}         icon={ScanLine}     bg="bg-sky-50"     fg="text-sky-600" />
            <StatCard label="PII Fields Found"  value={stats?.total_findings}      icon={ShieldAlert}  bg="bg-rose-50"    fg="text-rose-600" />
            <StatCard label="Confirmed"         value={stats?.confirmed_findings}  icon={CheckCircle2} bg="bg-emerald-50" fg="text-emerald-600" />
            <StatCard label="Unreviewed"        value={stats?.unreviewed_findings} icon={Clock}        bg="bg-amber-50"   fg="text-amber-600" />
            <StatCard label="Catalogue Entries" value={stats?.catalogue_entries}   icon={TrendingUp}   bg="bg-violet-50"  fg="text-violet-600" />
          </>
        )}
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        {/* Recent scans */}
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-slate-900">Recent Scan Runs</h2>
              <Link
                href="/scans"
                className="text-xs text-indigo-600 hover:text-indigo-700 flex items-center gap-1 font-medium transition-colors"
              >
                View all <ArrowRight size={11} />
              </Link>
            </div>
          </CardHeader>
          <div className="divide-y divide-slate-50">
            {loading ? (
              Array.from({ length: 4 }).map((_, i) => <SkeletonRow key={i} />)
            ) : scans.length === 0 ? (
              <div className="px-5 py-14 text-center">
                <div className="w-11 h-11 rounded-xl bg-slate-100 flex items-center justify-center mx-auto mb-3">
                  <ScanLine size={20} className="text-slate-400" />
                </div>
                <p className="text-sm font-semibold text-slate-700">No scans yet</p>
                <p className="text-sm text-slate-400 mt-1">
                  <Link href="/profiles" className="text-indigo-600 hover:underline font-medium">
                    Create a scan profile
                  </Link>{' '}
                  to get started.
                </p>
              </div>
            ) : scans.map(scan => (
              <Link
                key={scan.id}
                href={`/scans/${scan.id}`}
                className="flex items-center justify-between px-5 py-3.5 hover:bg-slate-50 transition-colors group"
              >
                <div className="min-w-0">
                  <p className="text-sm font-medium text-slate-800 group-hover:text-slate-900 truncate">
                    {scan.source_name}
                  </p>
                  <p className="text-xs text-slate-400 mt-0.5 truncate">
                    {scan.profile_name} · {formatDate(scan.started_at)}
                  </p>
                </div>
                <div className="flex items-center gap-2.5 ml-3 shrink-0">
                  <span className="text-xs text-slate-400 tabular-nums">
                    {scan.findings_count ?? 0} findings
                  </span>
                  <Badge
                    label={scan.status}
                    className={STATUS_COLOURS[scan.status] ?? ''}
                    size="sm"
                  />
                </div>
              </Link>
            ))}
          </div>
        </Card>

        {/* PII category chart */}
        <Card>
          <CardHeader>
            <h2 className="text-sm font-semibold text-slate-900">PII Category Breakdown</h2>
          </CardHeader>
          <CardBody className="pt-2">
            {loading ? (
              <div className="space-y-3 py-4">
                {Array.from({ length: 5 }).map((_, i) => (
                  <div key={i} className="flex items-center gap-3">
                    <Skeleton className="h-3 w-20 shrink-0" />
                    <Skeleton className="h-5 rounded" style={{ width: `${65 - i * 10}%` }} />
                  </div>
                ))}
              </div>
            ) : catData.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 text-center">
                <div className="w-11 h-11 rounded-xl bg-slate-100 flex items-center justify-center mb-3">
                  <TrendingUp size={19} className="text-slate-400" />
                </div>
                <p className="text-sm font-semibold text-slate-700">No data yet</p>
                <p className="text-xs text-slate-400 mt-1 leading-relaxed">
                  Run and publish a scan to see the breakdown.
                </p>
              </div>
            ) : (
              <ResponsiveContainer width="100%" height={248}>
                <BarChart
                  data={catData}
                  layout="vertical"
                  margin={{ left: 12, right: 20, top: 4, bottom: 4 }}
                >
                  <XAxis
                    type="number"
                    tick={{ fontSize: 11, fill: '#94a3b8' }}
                    tickLine={false}
                    axisLine={false}
                  />
                  <YAxis
                    type="category"
                    dataKey="pii_category"
                    tick={{ fontSize: 11, fill: '#64748b' }}
                    width={100}
                    tickLine={false}
                    axisLine={false}
                  />
                  <Tooltip
                    formatter={(v: any) => [v, 'Fields']}
                    contentStyle={{
                      fontSize: 12,
                      borderRadius: 8,
                      border: '1px solid #e2e8f0',
                      boxShadow: '0 4px 12px rgba(0,0,0,0.06)',
                    }}
                    cursor={{ fill: 'rgba(0,0,0,0.025)' }}
                  />
                  <Bar dataKey="total_fields" radius={[0, 5, 5, 0]} maxBarSize={18}>
                    {catData.map((_: any, i: number) => (
                      <Cell key={i} fill={BAR_COLOURS[i % BAR_COLOURS.length]} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            )}
          </CardBody>
        </Card>
      </div>
    </div>
  );
}
