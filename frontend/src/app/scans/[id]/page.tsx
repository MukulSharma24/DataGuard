'use client';

import { useEffect, useState, useRef, useCallback } from 'react';
import { getScan, getScanFindings, reviewFinding, publishScan, cancelScan } from '@/lib/api';
import {
  formatDate, STATUS_COLOURS, CONFIDENCE_COLOURS,
  REVIEW_COLOURS, PII_CATEGORY_COLOURS, PII_CATEGORIES
} from '@/lib/utils';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader, CardBody } from '@/components/ui/Card';
import { Skeleton } from '@/components/ui/Skeleton';
import { Modal } from '@/components/ui/Modal';
import {
  CheckCircle2, XCircle, RefreshCw, Upload,
  ChevronDown, ChevronRight, Eye, EyeOff, StopCircle,
  Table2
} from 'lucide-react';

interface Finding {
  id: string;
  table_name: string;
  field_path: string;
  pii_category: string;
  confidence_level: string;
  confidence_score: number;
  detection_reason: string;
  sample_values_masked: string[];
  review_status: string;
  published: boolean;
}

function SampleChip({ value }: { value: string }) {
  const [tip, setTip] = useState(false);
  const isLong = value.length > 12;
  return (
    <div
      className="relative"
      onMouseEnter={() => setTip(true)}
      onMouseLeave={() => setTip(false)}
    >
      <span className="font-mono text-[11px] bg-slate-100 text-slate-600 px-1.5 py-0.5 rounded border border-slate-200 max-w-[88px] truncate block cursor-default">
        {value}
      </span>
      {tip && isLong && (
        <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 z-50 pointer-events-none">
          <div className="bg-slate-900 text-white text-xs font-mono px-2.5 py-1.5 rounded-lg whitespace-nowrap shadow-xl">
            {value}
          </div>
          <div className="absolute top-full left-1/2 -translate-x-1/2 w-0 h-0 border-l-4 border-r-4 border-t-4 border-l-transparent border-r-transparent border-t-slate-900" />
        </div>
      )}
    </div>
  );
}

function SampleValues({ values }: { values: string[] }) {
  const [show, setShow] = useState(true);
  const valid = (values ?? []).filter(v => v && String(v).trim().length > 0);
  if (valid.length === 0) return (
    <div className="w-52 flex justify-end">
      <span className="text-slate-300 text-xs italic">no samples</span>
    </div>
  );
  return (
    <div className="w-52 flex items-center justify-end gap-1.5 shrink-0">
      <div className="flex items-center gap-1 overflow-visible">
        {show
          ? valid.slice(0, 3).map((v, i) => <SampleChip key={i} value={v} />)
          : <span className="text-xs text-slate-300 tracking-[0.3em] select-none">••••••</span>
        }
      </div>
      <button
        onClick={() => setShow(s => !s)}
        className="text-slate-300 hover:text-slate-500 shrink-0 transition-colors p-0.5 rounded"
        title={show ? 'Hide samples' : 'Show masked samples'}
      >
        {show ? <EyeOff size={12} /> : <Eye size={12} />}
      </button>
    </div>
  );
}

function FindingRow({ finding, onReview }: { finding: Finding; onReview: (f: Finding) => void }) {
  const leftBar =
    finding.confidence_level === 'HIGH'   ? 'bg-emerald-400' :
    finding.confidence_level === 'MEDIUM' ? 'bg-amber-400'   : 'bg-slate-200';

  return (
    <div className="flex border-b border-slate-50 last:border-0 hover:bg-slate-50/60 transition-colors group">
      <div className={`w-[3px] shrink-0 ${leftBar} rounded-r`} />
      <div className="flex items-start gap-4 px-5 py-3.5 flex-1 min-w-0">
        <div className="flex-1 min-w-0 pt-0.5">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-mono text-[13px] text-slate-800 font-medium">{finding.field_path}</span>
            <Badge
              label={finding.pii_category}
              className={`${PII_CATEGORY_COLOURS[finding.pii_category] ?? 'bg-slate-100 text-slate-600'} border-transparent text-[10px]`}
              size="sm"
            />
          </div>
          <p className="text-xs text-slate-400 mt-0.5 line-clamp-1 leading-relaxed">
            {finding.detection_reason}
          </p>
        </div>
        <div className="flex items-center gap-2.5 shrink-0">
          <SampleValues values={finding.sample_values_masked} />
          <Badge
            label={finding.confidence_level}
            className={CONFIDENCE_COLOURS[finding.confidence_level] ?? ''}
            size="sm"
          />
          <Badge
            label={finding.review_status}
            className={REVIEW_COLOURS[finding.review_status] ?? ''}
            size="sm"
          />
          <div className="w-16 flex justify-end">
            {finding.review_status === 'unreviewed' ? (
              <Button variant="secondary" size="sm" onClick={() => onReview(finding)}>
                Review
              </Button>
            ) : (
              <span className="text-xs text-slate-300">—</span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export default function ScanDetailPage({ params }: { params: { id: string } }) {
  const scanId = params.id;

  const [scan, setScan]             = useState<any>(null);
  const [findings, setFindings]     = useState<Finding[]>([]);
  const [loading, setLoading]       = useState(true);
  const [reviewing, setReviewing]   = useState<Finding | null>(null);
  const [reviewNote, setReviewNote] = useState('');
  const [reclassTo, setReclassTo]   = useState('');
  const [savingReview, setSavingReview]   = useState(false);
  const [publishing, setPublishing]       = useState(false);
  const [publishMsg, setPublishMsg]       = useState('');
  const [cancelling, setCancelling]       = useState(false);
  const [expandedTables, setExpandedTables] = useState<Set<string>>(new Set());
  const logRef = useRef<HTMLDivElement>(null);

  const loadScan = useCallback(async () => {
    const [s, f] = await Promise.all([getScan(scanId), getScanFindings(scanId)]);
    setScan(s.scan);
    setFindings(f.findings);
    setLoading(false);
  }, [scanId]);

  useEffect(() => { loadScan(); }, [loadScan]);

  useEffect(() => {
    if (!scan || !['running', 'pending'].includes(scan.status)) return;
    const t = setInterval(loadScan, 3000);
    return () => clearInterval(t);
  }, [scan, loadScan]);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [scan?.log]);

  async function handleReview(action: 'confirmed' | 'rejected' | 'reclassified') {
    if (!reviewing) return;
    setSavingReview(true);
    try {
      await reviewFinding(reviewing.id, {
        review_status: action,
        review_note:   reviewNote || undefined,
        pii_category:  action === 'reclassified' ? reclassTo : undefined,
      });
      setReviewing(null);
      setReviewNote('');
      setReclassTo('');
      await loadScan();
    } finally {
      setSavingReview(false);
    }
  }

  async function handlePublish() {
    setPublishing(true);
    try {
      const r = await publishScan(scanId);
      setPublishMsg(r.message);
      await loadScan();
    } finally {
      setPublishing(false);
    }
  }

  async function handleCancel() {
    setCancelling(true);
    try {
      await cancelScan(scanId);
      await loadScan();
    } finally {
      setCancelling(false);
    }
  }

  const byTable = findings.reduce<Record<string, Finding[]>>((acc, f) => {
    (acc[f.table_name] = acc[f.table_name] ?? []).push(f);
    return acc;
  }, {});

  const confirmedUnpublished = findings.filter(
    f => f.review_status === 'confirmed' && !f.published
  ).length;

  const inputCls =
    'w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 ' +
    'placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/30 ' +
    'focus:border-indigo-400 transition-colors';

  if (loading) return (
    <div className="p-8 space-y-6 animate-fadeIn">
      <div className="flex items-center justify-between">
        <div className="space-y-2">
          <Skeleton className="h-7 w-48" />
          <Skeleton className="h-4 w-72" />
        </div>
        <div className="flex gap-2">
          <Skeleton className="h-8 w-24 rounded-lg" />
        </div>
      </div>
      <div className="grid grid-cols-4 gap-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="rounded-xl border border-slate-200 bg-white p-5 shadow-card text-center">
            <Skeleton className="h-7 w-14 mx-auto mb-2" />
            <Skeleton className="h-3 w-20 mx-auto" />
          </div>
        ))}
      </div>
    </div>
  );

  if (!scan) return (
    <div className="p-8">
      <p className="text-sm text-slate-500">Scan not found.</p>
    </div>
  );

  return (
    <div className="p-8 space-y-6 animate-fadeIn">
      {/* Header */}
      <div className="flex items-start justify-between gap-4 pb-5 border-b border-slate-100">
        <div>
          <div className="flex items-center gap-2.5 flex-wrap">
            <h1 className="text-[22px] font-bold text-slate-900 tracking-tight">{scan.source_name}</h1>
            <Badge label={scan.status} className={STATUS_COLOURS[scan.status] ?? ''} dot />
          </div>
          <p className="text-sm text-slate-500 mt-1">
            Profile: <span className="text-slate-700 font-medium">{scan.profile_name}</span>
            {' · '}Started:{' '}
            <span className="text-slate-700">{formatDate(scan.started_at)}</span>
            {scan.completed_at && (
              <> · Completed: <span className="text-slate-700">{formatDate(scan.completed_at)}</span></>
            )}
          </p>
        </div>
        <div className="flex gap-2 shrink-0">
          <Button variant="secondary" size="sm" onClick={loadScan}>
            <RefreshCw size={13} /> Refresh
          </Button>
          {scan.status === 'running' && (
            <Button variant="danger" size="sm" loading={cancelling} onClick={handleCancel}>
              <StopCircle size={13} /> Cancel
            </Button>
          )}
          {['completed', 'partial'].includes(scan.status) && confirmedUnpublished > 0 && (
            <Button variant="success" size="sm" loading={publishing} onClick={handlePublish}>
              <Upload size={13} /> Publish {confirmedUnpublished} finding{confirmedUnpublished !== 1 ? 's' : ''}
            </Button>
          )}
        </div>
      </div>

      {/* Publish success */}
      {publishMsg && (
        <div className="rounded-lg bg-emerald-50 border border-emerald-200 px-4 py-3 text-sm text-emerald-700 flex items-center gap-2">
          <CheckCircle2 size={15} className="text-emerald-500 shrink-0" />
          {publishMsg}
        </div>
      )}

      {/* Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        {[
          { label: 'Tables Scanned', value: scan.tables_scanned, colour: 'text-slate-900' },
          { label: 'Findings',       value: findings.length,     colour: 'text-slate-900' },
          { label: 'Unreviewed',     value: findings.filter(f => f.review_status === 'unreviewed').length, colour: 'text-amber-600' },
          { label: 'Confirmed',      value: findings.filter(f => f.review_status === 'confirmed').length,  colour: 'text-emerald-600' },
        ].map(s => (
          <Card key={s.label}>
            <CardBody className="text-center py-5">
              <p className={`text-2xl font-bold tabular-nums tracking-tight leading-none ${s.colour}`}>
                {s.value}
              </p>
              <p className="text-xs text-slate-500 mt-2 font-medium">{s.label}</p>
            </CardBody>
          </Card>
        ))}
      </div>

      {/* Performance metrics */}
      {['completed', 'partial', 'cancelled'].includes(scan.status) && scan.scan_duration_ms && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          {[
            { label: 'Duration',     value: `${(scan.scan_duration_ms / 1000).toFixed(1)}s` },
            { label: 'Rows Sampled', value: scan.rows_sampled?.toLocaleString() ?? '—' },
            { label: 'Rows / sec',   value: scan.rows_per_second?.toLocaleString() ?? '—' },
            { label: 'LLM Added',    value: scan.classifier_stats?.llmAdded ?? 0 },
          ].map(s => (
            <Card key={s.label} className="border-dashed border-slate-200 bg-slate-50/50">
              <CardBody className="text-center py-4">
                <p className="text-xl font-bold text-indigo-700 tabular-nums tracking-tight">{s.value}</p>
                <p className="text-xs text-slate-500 mt-1.5 font-medium">{s.label}</p>
              </CardBody>
            </Card>
          ))}
        </div>
      )}

      {/* Live log */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold text-slate-900">Scan Log</h2>
            {scan.status === 'running' && (
              <div className="flex gap-1 ml-1">
                {[0, 150, 300].map(delay => (
                  <span
                    key={delay}
                    className="w-1.5 h-1.5 rounded-full bg-blue-500 animate-bounce"
                    style={{ animationDelay: `${delay}ms` }}
                  />
                ))}
              </div>
            )}
          </div>
        </CardHeader>
        <div
          ref={logRef}
          className="bg-[#0d1117] rounded-b-xl p-4 h-52 overflow-y-auto scrollbar-thin"
        >
          {scan.log ? (
            <pre className="text-xs text-emerald-400 font-mono whitespace-pre-wrap leading-[1.7]">
              {scan.log}
            </pre>
          ) : (
            <p className="text-xs text-slate-600 font-mono">{'// No log entries yet.'}</p>
          )}
        </div>
      </Card>

      {/* Findings by table */}
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold text-slate-900">Findings by Table</h2>
          <span className="text-xs text-slate-400 font-medium">
            ({findings.length} total)
          </span>
        </div>

        {Object.keys(byTable).length === 0 ? (
          <Card>
            <CardBody className="text-center py-12">
              <div className="w-11 h-11 rounded-xl bg-slate-100 flex items-center justify-center mx-auto mb-3">
                <Table2 size={20} className="text-slate-400" />
              </div>
              <p className="text-sm font-semibold text-slate-700">No PII findings</p>
              <p className="text-sm text-slate-400 mt-1">No PII was detected in this scan.</p>
            </CardBody>
          </Card>
        ) : Object.entries(byTable).map(([table, tFindings]) => {
          const expanded = expandedTables.has(table);
          return (
            <Card key={table}>
              <button
                className="w-full flex items-center justify-between px-5 py-4 hover:bg-slate-50/80 transition-colors text-left group"
                onClick={() => setExpandedTables(prev => {
                  const next = new Set(prev);
                  next.has(table) ? next.delete(table) : next.add(table);
                  return next;
                })}
              >
                <div className="flex items-center gap-2.5">
                  {expanded
                    ? <ChevronDown size={15} className="text-slate-400 shrink-0" />
                    : <ChevronRight size={15} className="text-slate-400 shrink-0" />
                  }
                  <span className="font-mono text-sm font-semibold text-slate-800">{table}</span>
                  <span className="text-xs text-slate-400 font-medium">
                    {tFindings.length} field{tFindings.length !== 1 ? 's' : ''}
                  </span>
                </div>
                <div className="flex items-center gap-1.5">
                  {['HIGH', 'MEDIUM', 'LOW'].map(lvl => {
                    const cnt = tFindings.filter(f => f.confidence_level === lvl).length;
                    if (!cnt) return null;
                    return (
                      <Badge
                        key={lvl}
                        label={`${cnt} ${lvl}`}
                        className={CONFIDENCE_COLOURS[lvl]}
                        size="sm"
                      />
                    );
                  })}
                </div>
              </button>
              {expanded && (
                <div className="border-t border-slate-100">
                  {tFindings.map(f => (
                    <FindingRow key={f.id} finding={f} onReview={setReviewing} />
                  ))}
                </div>
              )}
            </Card>
          );
        })}
      </div>

      {/* Review modal */}
      <Modal
        open={!!reviewing}
        onClose={() => setReviewing(null)}
        title="Review Finding"
        size="md"
      >
        {reviewing && (
          <div className="space-y-4">
            <div className="bg-slate-50 rounded-lg px-4 py-3 border border-slate-100">
              <p className="text-[10px] font-semibold text-slate-500 uppercase tracking-wide mb-1">Field</p>
              <p className="font-mono text-sm text-slate-900 font-medium">{reviewing.field_path}</p>
            </div>
            <div className="flex gap-2">
              <Badge
                label={reviewing.pii_category}
                className={PII_CATEGORY_COLOURS[reviewing.pii_category] ?? ''}
              />
              <Badge
                label={reviewing.confidence_level}
                className={CONFIDENCE_COLOURS[reviewing.confidence_level] ?? ''}
              />
            </div>
            <div>
              <p className="text-[10px] font-semibold text-slate-500 uppercase tracking-wide mb-1.5">
                Detection Reason
              </p>
              <p className="text-sm text-slate-700 leading-relaxed">{reviewing.detection_reason}</p>
            </div>
            <div>
              <label className="block text-[10px] font-semibold text-slate-500 uppercase tracking-wide mb-1.5">
                Reclassify to <span className="text-slate-400 normal-case font-normal">(optional)</span>
              </label>
              <select
                className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-indigo-500/30 focus:border-indigo-400 transition-colors"
                value={reclassTo}
                onChange={e => setReclassTo(e.target.value)}
              >
                <option value="">Keep as {reviewing.pii_category}</option>
                {PII_CATEGORIES.filter(c => c !== reviewing.pii_category).map(c => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-[10px] font-semibold text-slate-500 uppercase tracking-wide mb-1.5">
                Review Note
              </label>
              <textarea
                className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/30 focus:border-indigo-400 transition-colors resize-none"
                rows={3}
                value={reviewNote}
                onChange={e => setReviewNote(e.target.value)}
                placeholder="Optional note about this finding…"
              />
            </div>
            <div className="flex gap-2 pt-3 border-t border-slate-100">
              <Button
                variant="success"
                className="flex-1"
                loading={savingReview}
                onClick={() => handleReview(reclassTo ? 'reclassified' : 'confirmed')}
              >
                <CheckCircle2 size={14} />
                {reclassTo ? 'Reclassify' : 'Confirm'}
              </Button>
              <Button
                variant="danger"
                className="flex-1"
                loading={savingReview}
                onClick={() => handleReview('rejected')}
              >
                <XCircle size={14} /> Reject
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
