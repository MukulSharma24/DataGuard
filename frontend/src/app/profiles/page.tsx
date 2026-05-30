'use client';

import { useEffect, useState, useCallback } from 'react';
import { getProfiles, getSources, createProfile, deleteProfile, triggerScan } from '@/lib/api';
import { formatDate } from '@/lib/utils';
import { Button } from '@/components/ui/Button';
import { Card, CardBody } from '@/components/ui/Card';
import { Skeleton } from '@/components/ui/Skeleton';
import { Modal } from '@/components/ui/Modal';
import { Plus, Play, Trash2, Settings2, Database } from 'lucide-react';
import { useRouter } from 'next/navigation';

const inputCls =
  'w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 ' +
  'placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/30 ' +
  'focus:border-indigo-400 transition-colors';

const labelCls = 'block text-xs font-medium text-slate-600 mb-1.5';

function ProfileSkeleton() {
  return (
    <Card>
      <CardBody className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3.5 flex-1 min-w-0">
          <Skeleton className="w-10 h-10 rounded-xl shrink-0" />
          <div className="space-y-2 flex-1">
            <Skeleton className="h-4 w-2/5" />
            <Skeleton className="h-3 w-3/5" />
          </div>
        </div>
        <div className="flex gap-2">
          <Skeleton className="h-8 w-24 rounded-lg" />
          <Skeleton className="h-8 w-8 rounded-lg" />
        </div>
      </CardBody>
    </Card>
  );
}

export default function ProfilesPage() {
  const router = useRouter();
  const [profiles, setProfiles]   = useState<any[]>([]);
  const [sources, setSources]     = useState<any[]>([]);
  const [loading, setLoading]     = useState(true);
  const [modal, setModal]         = useState(false);
  const [saving, setSaving]       = useState(false);
  const [triggering, setTriggering] = useState<string | null>(null);

  const [form, setForm] = useState({
    source_id:          '',
    name:               '',
    description:        '',
    includeSchemas:     '',
    excludeSchemas:     '',
    includeCollections: '',
    excludeCollections: '',
    sampleSize:         100,
    batchSize:          20,
  });

  const load = useCallback(async () => {
    setLoading(true);
    const [p, s] = await Promise.all([getProfiles(), getSources()]);
    setProfiles(p.profiles ?? []);
    setSources(s.sources ?? []);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  function parseCsv(s: string) {
    return s.split(',').map(x => x.trim()).filter(Boolean);
  }

  async function handleCreate() {
    if (!form.source_id || !form.name.trim()) return;
    setSaving(true);
    try {
      await createProfile({
        source_id:   form.source_id,
        name:        form.name,
        description: form.description,
        config: {
          includeSchemas:     parseCsv(form.includeSchemas),
          excludeSchemas:     parseCsv(form.excludeSchemas),
          includeCollections: parseCsv(form.includeCollections),
          excludeCollections: parseCsv(form.excludeCollections),
          sampleSize:         form.sampleSize,
          batchSize:          form.batchSize,
        },
      });
      setModal(false);
      load();
    } finally {
      setSaving(false);
    }
  }

  async function handleTrigger(profileId: string) {
    if (triggering) return;
    setTriggering(profileId);
    await new Promise(r => setTimeout(r, 0));
    try {
      const r = await triggerScan(profileId);
      router.push(`/scans/${r.scan_run_id}`);
    } catch (err: any) {
      alert(err.message ?? 'Failed to trigger scan');
      setTriggering(null);
    }
  }

  return (
    <div className="p-8 space-y-6 animate-fadeIn">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-[22px] font-bold text-slate-900 tracking-tight">Scan Profiles</h1>
          <p className="text-sm text-slate-500 mt-1">Configure what gets scanned and how</p>
        </div>
        <Button size="sm" onClick={() => setModal(true)}>
          <Plus size={14} /> New Profile
        </Button>
      </div>

      {/* Content */}
      {loading ? (
        <div className="space-y-3">
          {Array.from({ length: 3 }).map((_, i) => <ProfileSkeleton key={i} />)}
        </div>
      ) : profiles.length === 0 ? (
        <Card>
          <CardBody className="flex flex-col items-center py-16 gap-3">
            <div className="w-12 h-12 rounded-xl bg-slate-100 flex items-center justify-center">
              <Settings2 size={22} className="text-slate-400" />
            </div>
            <div className="text-center">
              <p className="font-semibold text-slate-700">No scan profiles yet</p>
              <p className="text-sm text-slate-400 mt-1">
                Create a profile to configure and trigger scans.
              </p>
            </div>
            <Button size="sm" onClick={() => setModal(true)} className="mt-1">
              <Plus size={14} /> New Profile
            </Button>
          </CardBody>
        </Card>
      ) : (
        <div className="space-y-3">
          {profiles.map(p => (
            <Card key={p.id} className="hover:shadow-card-md transition-shadow duration-200">
              <CardBody className="flex items-center justify-between gap-4 py-4">
                <div className="flex items-center gap-3.5 min-w-0 flex-1">
                  <div className="w-10 h-10 rounded-xl bg-violet-50 flex items-center justify-center shrink-0">
                    <Settings2 size={17} className="text-violet-600" />
                  </div>
                  <div className="min-w-0">
                    <p className="font-semibold text-slate-900 text-sm leading-tight truncate">
                      {p.name}
                    </p>
                    <p className="text-xs text-slate-400 mt-0.5 flex items-center gap-1.5">
                      <Database size={11} className="text-slate-400" />
                      <span>{p.source_name}</span>
                      <span className="text-slate-300">·</span>
                      <span className="capitalize">{p.source_type}</span>
                      <span className="text-slate-300">·</span>
                      <span>Created {formatDate(p.created_at)}</span>
                    </p>
                    {p.description && (
                      <p className="text-xs text-slate-500 mt-1 leading-relaxed">{p.description}</p>
                    )}
                  </div>
                </div>
                <div className="flex gap-2 shrink-0">
                  <Button
                    variant="success"
                    size="sm"
                    loading={triggering === p.id}
                    onClick={() => handleTrigger(p.id)}
                  >
                    <Play size={12} /> Run Scan
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-slate-400 hover:text-rose-600 hover:bg-rose-50"
                    onClick={async () => {
                      if (confirm('Delete this profile?')) { await deleteProfile(p.id); load(); }
                    }}
                  >
                    <Trash2 size={13} />
                  </Button>
                </div>
              </CardBody>
            </Card>
          ))}
        </div>
      )}

      {/* New profile modal */}
      <Modal open={modal} onClose={() => setModal(false)} title="New Scan Profile" size="lg">
        <div className="space-y-4">
          <div>
            <label className={labelCls}>Data Source <span className="text-rose-400">*</span></label>
            <select
              className={inputCls}
              value={form.source_id}
              onChange={e => setForm({ ...form, source_id: e.target.value })}
            >
              <option value="">Select a source…</option>
              {sources.map(s => (
                <option key={s.id} value={s.id}>{s.name} ({s.type})</option>
              ))}
            </select>
          </div>
          <div>
            <label className={labelCls}>Profile Name <span className="text-rose-400">*</span></label>
            <input
              className={inputCls}
              value={form.name}
              onChange={e => setForm({ ...form, name: e.target.value })}
              placeholder="e.g. Full PII Scan"
            />
          </div>
          <div>
            <label className={labelCls}>Description</label>
            <input
              className={inputCls}
              value={form.description}
              onChange={e => setForm({ ...form, description: e.target.value })}
              placeholder="Optional description…"
            />
          </div>

          {(() => {
            const selectedSrc = sources.find((s: any) => s.id === form.source_id);
            const isMongo = selectedSrc?.type === 'mongodb';
            return (
              <div className="grid grid-cols-2 gap-3">
                {isMongo ? (
                  <>
                    <div>
                      <label className={labelCls}>Include Collections <span className="text-slate-400 font-normal">(CSV)</span></label>
                      <input
                        className={inputCls}
                        value={form.includeCollections}
                        onChange={e => setForm({ ...form, includeCollections: e.target.value })}
                        placeholder="users, orders"
                      />
                    </div>
                    <div>
                      <label className={labelCls}>Exclude Collections <span className="text-slate-400 font-normal">(CSV)</span></label>
                      <input
                        className={inputCls}
                        value={form.excludeCollections}
                        onChange={e => setForm({ ...form, excludeCollections: e.target.value })}
                        placeholder="logs, sessions"
                      />
                    </div>
                  </>
                ) : (
                  <>
                    <div>
                      <label className={labelCls}>Include Schemas <span className="text-slate-400 font-normal">(CSV)</span></label>
                      <input
                        className={inputCls}
                        value={form.includeSchemas}
                        onChange={e => setForm({ ...form, includeSchemas: e.target.value })}
                        placeholder="public, customers"
                      />
                    </div>
                    <div>
                      <label className={labelCls}>Exclude Schemas <span className="text-slate-400 font-normal">(CSV)</span></label>
                      <input
                        className={inputCls}
                        value={form.excludeSchemas}
                        onChange={e => setForm({ ...form, excludeSchemas: e.target.value })}
                        placeholder="audit, logs"
                      />
                    </div>
                  </>
                )}
                <div>
                  <label className={labelCls}>Sample Size</label>
                  <input
                    className={inputCls}
                    type="number"
                    value={form.sampleSize}
                    onChange={e => setForm({ ...form, sampleSize: +e.target.value })}
                    min={1}
                    max={1000}
                  />
                </div>
                <div>
                  <label className={labelCls}>Batch Size</label>
                  <input
                    className={inputCls}
                    type="number"
                    value={form.batchSize}
                    onChange={e => setForm({ ...form, batchSize: +e.target.value })}
                    min={1}
                    max={100}
                  />
                </div>
              </div>
            );
          })()}

          <div className="flex justify-end gap-2 pt-3 border-t border-slate-100 mt-2">
            <Button variant="secondary" onClick={() => setModal(false)}>Cancel</Button>
            <Button
              loading={saving}
              onClick={handleCreate}
              disabled={!form.source_id || !form.name.trim()}
            >
              Create Profile
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
