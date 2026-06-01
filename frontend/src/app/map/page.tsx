'use client';

import { useEffect, useState } from 'react';
import { getCatalogueBySource } from '@/lib/api';
import { PII_CATEGORY_COLOURS } from '@/lib/utils';
import { Badge } from '@/components/ui/Badge';
import { Card, CardHeader, CardBody } from '@/components/ui/Card';
import { Skeleton } from '@/components/ui/Skeleton';
import { Map, Database, ChevronRight } from 'lucide-react';
import { getCatalogue } from '@/lib/api';

export default function DataMapPage() {
  const [bySource, setBySource]   = useState<any[]>([]);
  const [allEntries, setAllEntries] = useState<any[]>([]);
  const [loading, setLoading]     = useState(true);
  const [selected, setSelected]   = useState<string | null>(null);

  useEffect(() => {
    Promise.all([getCatalogueBySource(), getCatalogue()])
      .then(([s, e]) => { setBySource(s.bySource ?? []); setAllEntries(e.entries ?? []); })
      .finally(() => setLoading(false));
  }, []);

  const sourceEntries = selected
    ? allEntries.filter(e => e.source_id === selected)
    : [];

  const byCat: Record<string, any[]> = {};
  for (const e of sourceEntries) {
    (byCat[e.pii_category] = byCat[e.pii_category] ?? []).push(e);
  }

  if (loading) return (
    <div className="p-8 space-y-6 animate-fadeIn">
      <div className="space-y-2">
        <Skeleton className="h-7 w-32" />
        <Skeleton className="h-4 w-72" />
      </div>
      <div className="flex gap-6">
        <div className="w-64 space-y-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="rounded-xl border border-slate-200 bg-white p-4">
              <Skeleton className="h-4 w-3/4 mb-2" />
              <Skeleton className="h-3 w-1/2 mb-3" />
              <div className="flex gap-1">
                <Skeleton className="h-5 w-14 rounded-full" />
                <Skeleton className="h-5 w-12 rounded-full" />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );

  return (
    <div className="p-8 space-y-6 animate-fadeIn">
      {/* Header */}
      <div className="pb-5 border-b border-slate-100">
        <h1 className="text-[22px] font-bold text-slate-900 tracking-tight">Data Map</h1>
        <p className="text-sm text-slate-500 mt-1">
          Visual layout of discovered PII across your data sources
          <span className="text-slate-400 ml-1 text-xs">(based on published catalogue entries)</span>
        </p>
      </div>

      {bySource.length === 0 ? (
        <Card>
          <CardBody className="flex flex-col items-center py-16 gap-3">
            <div className="w-12 h-12 rounded-xl bg-slate-100 flex items-center justify-center">
              <Map size={22} className="text-slate-400" />
            </div>
            <div className="text-center">
              <p className="font-semibold text-slate-700">No data map available yet</p>
              <p className="text-sm text-slate-400 mt-1">
                Publish findings to the catalogue to see the data map.
              </p>
            </div>
          </CardBody>
        </Card>
      ) : (
        <div className="flex gap-5 items-start">
          {/* Source list */}
          <div className="w-64 shrink-0 space-y-2">
            <p className="text-[11px] font-semibold text-slate-400 uppercase tracking-wide mb-3">
              Data Sources
            </p>
            {bySource.map(src => (
              <button
                key={src.source_id}
                onClick={() => setSelected(selected === src.source_id ? null : src.source_id)}
                className={`w-full text-left rounded-xl border p-4 transition-all duration-150 ${
                  selected === src.source_id
                    ? 'border-indigo-300 bg-indigo-50 shadow-sm shadow-indigo-100'
                    : 'border-slate-200 bg-white hover:border-slate-300 hover:shadow-card'
                }`}
              >
                <div className="flex items-center gap-2 mb-1.5">
                  <Database
                    size={14}
                    className={selected === src.source_id ? 'text-indigo-500' : 'text-slate-400'}
                  />
                  <span className={`font-semibold text-sm leading-tight ${
                    selected === src.source_id ? 'text-indigo-700' : 'text-slate-800'
                  }`}>
                    {src.source_name}
                  </span>
                </div>
                <p className="text-xs text-slate-400 mb-2.5">
                  <span className="capitalize">{src.source_type}</span>
                  {' · '}{src.total_fields} field{src.total_fields !== 1 ? 's' : ''}
                  {' · '}{src.categories_found} categories
                </p>
                <div className="flex flex-wrap gap-1">
                  {(src.categories as string[]).slice(0, 4).map((c: string) => (
                    <Badge
                      key={c}
                      label={c}
                      size="sm"
                      className={`${PII_CATEGORY_COLOURS[c] ?? 'bg-slate-100 text-slate-600'} border-transparent`}
                    />
                  ))}
                  {src.categories.length > 4 && (
                    <span className="text-[11px] text-slate-400 font-medium self-center">
                      +{src.categories.length - 4}
                    </span>
                  )}
                </div>
              </button>
            ))}
          </div>

          {/* Arrow connector */}
          {selected && (
            <div className="flex items-start pt-20 shrink-0">
              <ChevronRight size={18} className="text-slate-300" />
            </div>
          )}

          {/* Category breakdown */}
          {selected && (
            <div className="flex-1 space-y-3 min-w-0">
              <p className="text-[11px] font-semibold text-slate-400 uppercase tracking-wide mb-3">
                PII Categories in{' '}
                <span className="text-slate-600">
                  {bySource.find(s => s.source_id === selected)?.source_name}
                </span>
              </p>
              {Object.entries(byCat).map(([cat, fields]) => (
                <Card key={cat}>
                  <CardHeader className="py-3">
                    <div className="flex items-center gap-2">
                      <Badge
                        label={cat}
                        className={`${PII_CATEGORY_COLOURS[cat] ?? 'bg-slate-100 text-slate-600'} border-transparent`}
                      />
                      <span className="text-xs text-slate-400 font-medium">
                        {fields.length} field{fields.length !== 1 ? 's' : ''}
                      </span>
                    </div>
                  </CardHeader>
                  <CardBody className="py-3">
                    <div className="flex flex-wrap gap-2">
                      {fields.map((f: any) => (
                        <div
                          key={f.id}
                          className="bg-white border border-slate-200 rounded-lg px-3 py-2 text-xs hover:border-slate-300 hover:shadow-card transition-all duration-150"
                        >
                          <p className="font-mono font-medium text-slate-800">{f.field_path}</p>
                          <p className="text-slate-400 mt-0.5">
                            {f.schema_name !== 'default' ? `${f.schema_name}.` : ''}
                            {f.table_name}
                          </p>
                        </div>
                      ))}
                    </div>
                  </CardBody>
                </Card>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
