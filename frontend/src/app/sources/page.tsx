'use client';

import { useEffect, useState, useCallback } from 'react';
import { getSources, getSource, createSource, updateSource, testSource, deleteSource } from '@/lib/api';
import { formatDate, STATUS_COLOURS } from '@/lib/utils';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader, CardBody } from '@/components/ui/Card';
import { Skeleton } from '@/components/ui/Skeleton';
import { Modal } from '@/components/ui/Modal';
import {
  Plus, RefreshCw, Trash2, TestTube2, Database,
  CheckCircle2, XCircle, Pencil, ShieldAlert, Zap
} from 'lucide-react';

type SourceType = 'postgresql' | 'mongodb';

const EMPTY_PG = { host: '', port: 5432, database: '', user: '', password: '', ssl: false };
const EMPTY_MG = { host: '', port: 27017, database: '', user: '', password: '', connectionString: '' };

const inputCls =
  'w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 ' +
  'placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/30 ' +
  'focus:border-indigo-400 transition-colors';

const labelCls = 'block text-xs font-medium text-slate-600 mb-1.5';

function SourceForm({ type, config, onChange }: any) {
  const f = (k: string) => (e: any) => onChange({ ...config, [k]: e.target.value });

  if (type === 'postgresql') return (
    <div className="grid grid-cols-2 gap-3">
      <div className="col-span-2">
        <label className={labelCls}>Host</label>
        <input className={inputCls} value={config.host} onChange={f('host')} placeholder="localhost" />
      </div>
      <div>
        <label className={labelCls}>Port</label>
        <input className={inputCls} type="number" value={config.port} onChange={f('port')} />
      </div>
      <div>
        <label className={labelCls}>Database</label>
        <input className={inputCls} value={config.database} onChange={f('database')} placeholder="mydb" />
      </div>
      <div>
        <label className={labelCls}>User</label>
        <input className={inputCls} value={config.user} onChange={f('user')} placeholder="postgres" />
      </div>
      <div>
        <label className={labelCls}>Password</label>
        <input className={inputCls} type="password" value={config.password} onChange={f('password')} placeholder="••••••••" />
      </div>
      <div className="col-span-2 flex items-center gap-2.5 pt-1">
        <input
          type="checkbox"
          id="ssl"
          checked={config.ssl}
          onChange={e => onChange({ ...config, ssl: e.target.checked })}
          className="w-4 h-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500/30"
        />
        <label htmlFor="ssl" className="text-sm text-slate-600 select-none cursor-pointer">
          Enable SSL
        </label>
      </div>
    </div>
  );

  return (
    <div className="space-y-3">
      <div>
        <label className={labelCls}>Connection String <span className="text-slate-400 font-normal">(optional)</span></label>
        <input
          className={inputCls}
          value={config.connectionString}
          onChange={f('connectionString')}
          placeholder="mongodb://user:pass@host:27017/db"
        />
      </div>
      <div className="relative flex items-center gap-3 py-1">
        <div className="flex-1 border-t border-slate-200" />
        <span className="text-xs text-slate-400 shrink-0">or fill individually</span>
        <div className="flex-1 border-t border-slate-200" />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className={labelCls}>Host</label>
          <input className={inputCls} value={config.host} onChange={f('host')} placeholder="localhost" />
        </div>
        <div>
          <label className={labelCls}>Port</label>
          <input className={inputCls} type="number" value={config.port} onChange={f('port')} />
        </div>
        <div>
          <label className={labelCls}>Database</label>
          <input className={inputCls} value={config.database} onChange={f('database')} placeholder="mydb" />
        </div>
        <div>
          <label className={labelCls}>User</label>
          <input className={inputCls} value={config.user} onChange={f('user')} />
        </div>
        <div className="col-span-2">
          <label className={labelCls}>Password</label>
          <input className={inputCls} type="password" value={config.password} onChange={f('password')} />
        </div>
      </div>
    </div>
  );
}

function SourceSkeleton() {
  return (
    <Card>
      <CardBody className="flex items-center gap-4">
        <Skeleton className="w-10 h-10 rounded-xl shrink-0" />
        <div className="flex-1 space-y-2">
          <Skeleton className="h-4 w-1/4" />
          <Skeleton className="h-3 w-2/5" />
        </div>
        <div className="flex gap-2">
          <Skeleton className="h-7 w-16 rounded-lg" />
          <Skeleton className="h-7 w-16 rounded-lg" />
          <Skeleton className="h-7 w-8 rounded-lg" />
        </div>
      </CardBody>
    </Card>
  );
}

export default function SourcesPage() {
  const [sources, setSources]     = useState<any[]>([]);
  const [loading, setLoading]     = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const [modal, setModal]         = useState(false);
  const [srcType, setSrcType]     = useState<SourceType>('postgresql');
  const [name, setName]           = useState('');
  const [config, setConfig]       = useState<any>({ ...EMPTY_PG });
  const [saving, setSaving]       = useState(false);

  const [editModal, setEditModal]   = useState(false);
  const [editSrc, setEditSrc]       = useState<any>(null);
  const [editName, setEditName]     = useState('');
  const [editConfig, setEditConfig] = useState<any>({});
  const [editSaving, setEditSaving] = useState(false);

  const [testResults, setTestResults] = useState<Record<string, any>>({});
  const [testing, setTesting]     = useState<string | null>(null);

  const load = useCallback((manual = false) => {
    if (manual) setRefreshing(true); else setLoading(true);
    getSources()
      .then(r => setSources(r.sources ?? []))
      .finally(() => { setLoading(false); setRefreshing(false); });
  }, []);

  useEffect(() => { load(); }, [load]);

  function openModal() {
    setName(''); setSrcType('postgresql'); setConfig({ ...EMPTY_PG }); setModal(true);
  }

  async function handleCreate() {
    if (!name.trim()) return;
    setSaving(true);
    try {
      await createSource({ name, type: srcType, config });
      setModal(false);
      load();
    } finally {
      setSaving(false);
    }
  }

  async function openEdit(src: any) {
    try {
      const r = await getSource(src.id);
      setEditSrc(r.source);
      setEditName(r.source.name);
      const mc = r.source.maskedConfig ?? {};
      setEditConfig({ ...mc, password: '' });
    } catch {
      setEditSrc(src);
      setEditName(src.name);
      setEditConfig({});
    }
    setEditModal(true);
  }

  async function handleEdit() {
    if (!editSrc || !editName.trim()) return;
    setEditSaving(true);
    try {
      await updateSource(editSrc.id, { name: editName, config: editConfig });
      setEditModal(false);
      load();
    } finally {
      setEditSaving(false);
    }
  }

  async function handleTest(id: string) {
    setTesting(id);
    try {
      const r = await testSource(id);
      setTestResults(prev => ({ ...prev, [id]: r }));
      load();
    } finally {
      setTesting(null);
    }
  }

  async function handleDelete(id: string) {
    if (!confirm('Delete this data source and all its scan history?')) return;
    await deleteSource(id);
    load();
  }

  return (
    <div className="p-8 space-y-6 animate-fadeIn">
      {/* Header */}
      <div className="flex items-center justify-between pb-5 border-b border-slate-100">
        <div>
          <h1 className="text-[22px] font-bold text-slate-900 tracking-tight">Data Sources</h1>
          <p className="text-sm text-slate-500 mt-1">Manage the databases DataGuard scans for PII</p>
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" size="sm" onClick={() => load(true)} disabled={refreshing || loading} title="Refresh">
            <RefreshCw size={13} className={refreshing ? 'animate-spin' : ''} />
          </Button>
          <Button size="sm" onClick={openModal}>
            <Plus size={14} /> Add Source
          </Button>
        </div>
      </div>

      {/* Content */}
      {loading ? (
        <div className="space-y-3">
          {Array.from({ length: 3 }).map((_, i) => <SourceSkeleton key={i} />)}
        </div>
      ) : sources.length === 0 ? (
        <Card>
          <CardBody className="flex flex-col items-center py-16 gap-3">
            <div className="w-12 h-12 rounded-xl bg-slate-100 flex items-center justify-center">
              <Database size={22} className="text-slate-400" />
            </div>
            <div className="text-center">
              <p className="font-semibold text-slate-700">No data sources yet</p>
              <p className="text-sm text-slate-400 mt-1">
                Add your first PostgreSQL or MongoDB source to get started.
              </p>
            </div>
            <Button size="sm" onClick={openModal} className="mt-1">
              <Plus size={14} /> Add Source
            </Button>
          </CardBody>
        </Card>
      ) : (
        <div className="space-y-3">
          {sources.map(src => {
            const tr = testResults[src.id];
            return (
              <Card key={src.id} className="hover:shadow-card-md hover:-translate-y-px transition-all duration-200 group">
                <CardBody className="flex items-center justify-between gap-4 py-4">
                  <div className="flex items-center gap-3.5 min-w-0">
                    <div className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 transition-transform duration-200 group-hover:scale-105 ${
                      src.type === 'postgresql' ? 'bg-blue-50' : 'bg-emerald-50'
                    }`}>
                      <Database size={17} className={src.type === 'postgresql' ? 'text-blue-600' : 'text-emerald-600'} />
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="font-semibold text-slate-900 text-sm leading-tight truncate">
                          {src.name}
                        </p>
                        <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded uppercase tracking-wide shrink-0 ${
                          src.type === 'postgresql'
                            ? 'bg-blue-50 text-blue-700'
                            : 'bg-emerald-50 text-emerald-700'
                        }`}>
                          {src.type === 'postgresql' ? 'PG' : 'MDB'}
                        </span>
                      </div>
                      <p className="text-xs text-slate-400 mt-0.5">
                        Last scanned:{' '}
                        <span className="text-slate-500">{formatDate(src.last_scanned)}</span>
                      </p>
                    </div>
                  </div>

                  <div className="flex items-center gap-3 shrink-0">
                    {/* PII count */}
                    {src.pii_fields_found > 0 ? (
                      <span className="inline-flex items-center gap-1.5 text-xs font-semibold bg-rose-50 text-rose-700 border border-rose-100 rounded-full px-2.5 py-1">
                        <ShieldAlert size={11} />
                        {src.pii_fields_found} PII field{src.pii_fields_found !== 1 ? 's' : ''}
                      </span>
                    ) : (
                      <span className="text-xs text-slate-400 bg-slate-50 rounded-full px-2.5 py-1">No PII found</span>
                    )}

                    {/* Test result */}
                    {tr && (
                      <span className={`text-xs flex items-center gap-1 font-medium ${tr.success ? 'text-emerald-600' : 'text-rose-500'}`}>
                        {tr.success
                          ? <><CheckCircle2 size={13} /> {tr.latencyMs}ms</>
                          : <><XCircle size={13} /> {tr.error}</>
                        }
                      </span>
                    )}

                    <Badge
                      label={src.status}
                      className={STATUS_COLOURS[src.status] ?? ''}
                      size="sm"
                      dot
                    />

                    <div className="flex items-center gap-1.5 border-l border-slate-100 pl-3">
                      <Button
                        variant="secondary"
                        size="sm"
                        loading={testing === src.id}
                        onClick={() => handleTest(src.id)}
                        title="Test connection"
                      >
                        <Zap size={12} /> Test
                      </Button>
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => openEdit(src)}
                        title="Edit source"
                      >
                        <Pencil size={12} /> Edit
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleDelete(src.id)}
                        title="Delete source"
                        className="text-slate-400 hover:text-rose-600 hover:bg-rose-50"
                      >
                        <Trash2 size={13} />
                      </Button>
                    </div>
                  </div>
                </CardBody>
              </Card>
            );
          })}
        </div>
      )}

      {/* Add source modal */}
      <Modal open={modal} onClose={() => setModal(false)} title="Add Data Source" size="lg">
        <div className="space-y-4">
          <div>
            <label className={labelCls}>Source Name</label>
            <input
              className={inputCls}
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="e.g. Production DB"
            />
          </div>
          <div>
            <label className={labelCls}>Database Type</label>
            <div className="flex gap-2 mt-1">
              {(['postgresql', 'mongodb'] as SourceType[]).map(t => (
                <button
                  key={t}
                  onClick={() => {
                    setSrcType(t);
                    setConfig(t === 'postgresql' ? { ...EMPTY_PG } : { ...EMPTY_MG } as any);
                  }}
                  className={`flex-1 py-2.5 rounded-lg border text-sm font-medium transition-all ${
                    srcType === t
                      ? 'border-indigo-400 bg-indigo-50 text-indigo-700 shadow-sm'
                      : 'border-slate-200 text-slate-500 hover:border-slate-300 hover:text-slate-700'
                  }`}
                >
                  {t === 'postgresql' ? 'PostgreSQL' : 'MongoDB'}
                </button>
              ))}
            </div>
          </div>
          <SourceForm type={srcType} config={config} onChange={setConfig} />
          <div className="flex justify-end gap-2 pt-3 border-t border-slate-100 mt-2">
            <Button variant="secondary" onClick={() => setModal(false)}>Cancel</Button>
            <Button loading={saving} onClick={handleCreate} disabled={!name.trim()}>
              Save Source
            </Button>
          </div>
        </div>
      </Modal>

      {/* Edit source modal */}
      {editSrc && (
        <Modal open={editModal} onClose={() => setEditModal(false)} title="Edit Data Source" size="lg">
          <div className="space-y-4">
            <div>
              <label className={labelCls}>Source Name</label>
              <input
                className={inputCls}
                value={editName}
                onChange={e => setEditName(e.target.value)}
              />
            </div>
            <div>
              <label className={labelCls}>Type</label>
              <p className="text-sm text-slate-700 font-medium capitalize mt-0.5">{editSrc.type}</p>
            </div>
            <div className="rounded-lg bg-amber-50 border border-amber-200 px-3.5 py-2.5 text-xs text-amber-700 leading-relaxed">
              Connection fields are pre-filled from saved config. Leave Password blank to keep the existing password.
            </div>
            <SourceForm type={editSrc.type} config={editConfig} onChange={setEditConfig} />
            <div className="flex justify-end gap-2 pt-3 border-t border-slate-100 mt-2">
              <Button variant="secondary" onClick={() => setEditModal(false)}>Cancel</Button>
              <Button loading={editSaving} onClick={handleEdit} disabled={!editName.trim()}>
                Save Changes
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
