'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { getCatalogue, getSources } from '@/lib/api';
import { formatDate, PII_CATEGORY_COLOURS, PII_CATEGORIES } from '@/lib/utils';
import { Badge } from '@/components/ui/Badge';
import { Card, CardBody } from '@/components/ui/Card';
import { SkeletonCard } from '@/components/ui/Skeleton';
import { BookOpen, RefreshCw, Clock, SlidersHorizontal, ArrowUpRight } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import Link from 'next/link';

type View = 'published' | 'pending';

export default function CataloguePage() {
  const [entries, setEntries]   = useState<any[]>([]);
  const [sources, setSources]   = useState<any[]>([]);
  const [loading, setLoading]   = useState(true);
  const [view, setView]         = useState<View>('published');
  const [srcFilter, setSrcFilter]   = useState('');
  const [catFilter, setCatFilter]   = useState('');
  const [debouncedSrc, setDebouncedSrc] = useState('');
  const [debouncedCat, setDebouncedCat] = useState('');
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      setDebouncedSrc(srcFilter);
      setDebouncedCat(catFilter);
    }, 350);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [srcFilter, catFilter]);

  const load = useCallback(() => {
    setLoading(true);
    const params: any = { view };
    if (debouncedSrc) params.source_id = debouncedSrc;
    if (debouncedCat) params.category  = debouncedCat;
    Promise.all([getCatalogue(params), getSources()])
      .then(([e, s]) => { setEntries(e.entries ?? []); setSources(s.sources ?? []); })
      .finally(() => setLoading(false));
  }, [view, debouncedSrc, debouncedCat]);

  useEffect(() => { load(); }, [load]);

  const isPending = view === 'pending';
  const selectCls =
    'rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-700 ' +
    'focus:outline-none focus:ring-2 focus:ring-indigo-500/30 focus:border-indigo-400 transition-colors';

  return (
    <div className="p-8 space-y-6 animate-fadeIn">
      {/* Header */}
      <div className="flex items-start justify-between gap-4 pb-5 border-b border-slate-100">
        <div>
          <h1 className="text-[22px] font-bold text-slate-900 tracking-tight">Data Catalogue</h1>
          <p className="text-sm text-slate-500 mt-1 max-w-lg leading-relaxed">
            {isPending
              ? 'Unreviewed findings awaiting review — not yet confirmed or rejected'
              : "Published, confirmed PII findings — your organisation's official data privacy inventory"}
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <SlidersHorizontal size={14} className="text-slate-400" />
          <select value={srcFilter} onChange={e => setSrcFilter(e.target.value)} className={selectCls}>
            <option value="">All Sources</option>
            {sources.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          <select value={catFilter} onChange={e => setCatFilter(e.target.value)} className={selectCls}>
            <option value="">All Categories</option>
            {PII_CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
          <Button variant="secondary" size="sm" onClick={load} title="Refresh">
            <RefreshCw size={13} />
          </Button>
        </div>
      </div>

      {/* View toggle */}
      <div className="flex gap-1 p-1 bg-slate-100/80 rounded-xl w-fit border border-slate-200/60">
        {(['published', 'pending'] as View[]).map(v => (
          <button
            key={v}
            onClick={() => setView(v)}
            className={`px-4 py-1.5 rounded-md text-sm font-medium transition-all duration-150 ${
              view === v
                ? 'bg-white text-slate-900 shadow-sm ring-1 ring-slate-200/60'
                : 'text-slate-500 hover:text-slate-700'
            }`}
          >
            {v === 'published' ? 'Published' : 'Pending Review'}
          </button>
        ))}
      </div>

      {/* Content */}
      {loading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {Array.from({ length: 6 }).map((_, i) => <SkeletonCard key={i} />)}
        </div>
      ) : entries.length === 0 ? (
        <Card>
          <CardBody className="flex flex-col items-center py-16 gap-3">
            <div className="w-12 h-12 rounded-xl bg-slate-100 flex items-center justify-center">
              {isPending
                ? <Clock size={22} className="text-slate-400" />
                : <BookOpen size={22} className="text-slate-400" />
              }
            </div>
            <div className="text-center">
              <p className="font-semibold text-slate-700">
                {isPending ? 'No pending findings' : 'No catalogue entries yet'}
              </p>
              <p className="text-sm text-slate-400 mt-1 max-w-sm leading-relaxed">
                {isPending
                  ? 'All findings have been reviewed, or no scans have been run yet.'
                  : 'Run a scan, confirm findings in the Scan Review page, then click "Publish to Catalogue".'}
              </p>
            </div>
          </CardBody>
        </Card>
      ) : (
        <>
          {isPending && (
            <div className="flex items-start gap-2.5 rounded-lg bg-amber-50 border border-amber-200 px-4 py-3 text-sm text-amber-700">
              <ArrowUpRight size={15} className="shrink-0 mt-0.5 text-amber-500" />
              <span>
                Click <strong>Review</strong> on any card to open that scan and confirm, reject, or reclassify the finding.
              </span>
            </div>
          )}
          <p className="text-xs font-medium text-slate-400 tabular-nums">
            {entries.length} {isPending ? 'unreviewed' : 'published'} field{entries.length !== 1 ? 's' : ''}
          </p>
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {entries.map(entry => (
              <Card
                key={entry.id}
                className="hover:shadow-card-md transition-all duration-200 hover:-translate-y-px"
              >
                <CardBody className="p-5">
                  <div className="flex items-start justify-between gap-2 mb-3">
                    <div className="min-w-0 flex-1">
                      <p className="font-mono text-sm font-bold text-slate-900 truncate leading-tight">
                        {entry.field_path}
                      </p>
                      <p className="text-xs text-slate-400 mt-1 truncate">
                        {entry.source_name}
                        {' / '}
                        {entry.schema_name !== 'default' ? `${entry.schema_name}.` : ''}
                        {entry.table_name}
                      </p>
                    </div>
                    <Badge
                      label={entry.pii_category}
                      className={`${PII_CATEGORY_COLOURS[entry.pii_category] ?? 'bg-slate-100 text-slate-600'} border-transparent shrink-0`}
                      size="sm"
                    />
                  </div>
                  <div className="flex items-center justify-between pt-3 border-t border-slate-100">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-[11px] text-slate-400 capitalize font-medium">
                        {entry.source_type}
                      </span>
                      <span className="text-slate-200">·</span>
                      <span className="text-[11px] text-slate-400 font-medium">
                        {entry.confidence_level}
                      </span>
                      {isPending && (
                        <>
                          <span className="text-slate-200">·</span>
                          <span className="text-[11px] text-amber-600 font-semibold">Unreviewed</span>
                        </>
                      )}
                    </div>
                    {isPending && entry.scan_run_id ? (
                      <Link
                        href={`/scans/${entry.scan_run_id}`}
                        className="inline-flex items-center gap-1 text-[11px] font-semibold text-indigo-600 hover:text-indigo-700 transition-colors shrink-0"
                      >
                        Review <ArrowUpRight size={11} />
                      </Link>
                    ) : (
                      <p className="text-[11px] text-slate-400">
                        {formatDate(entry.confirmed_at)}
                      </p>
                    )}
                  </div>
                </CardBody>
              </Card>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
