import { clsx, type ClassValue } from 'clsx';

export function cn(...inputs: ClassValue[]) {
  return clsx(inputs);
}

export function formatDate(iso: string | null | undefined) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-IN', {
    day:    '2-digit',
    month:  'short',
    year:   'numeric',
    hour:   '2-digit',
    minute: '2-digit',
  });
}

export function formatDateShort(iso: string | null | undefined) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric',
  });
}

export const CONFIDENCE_COLOURS: Record<string, string> = {
  HIGH:   'bg-emerald-100 text-emerald-800 border-emerald-200',
  MEDIUM: 'bg-amber-100   text-amber-800   border-amber-200',
  LOW:    'bg-rose-100    text-rose-800    border-rose-200',
};

export const STATUS_COLOURS: Record<string, string> = {
  running:   'bg-blue-100   text-blue-800   border-blue-200',
  completed: 'bg-emerald-100 text-emerald-800 border-emerald-200',
  partial:   'bg-amber-100   text-amber-800   border-amber-200',
  failed:    'bg-rose-100    text-rose-800    border-rose-200',
  cancelled: 'bg-slate-200   text-slate-600   border-slate-300',
  pending:   'bg-slate-100   text-slate-700   border-slate-200',
  active:    'bg-emerald-100 text-emerald-800 border-emerald-200',
  inactive:  'bg-slate-100   text-slate-700   border-slate-200',
  error:     'bg-rose-100    text-rose-800    border-rose-200',
};

export const REVIEW_COLOURS: Record<string, string> = {
  unreviewed:    'bg-slate-100   text-slate-700   border-slate-200',
  confirmed:     'bg-emerald-100 text-emerald-800 border-emerald-200',
  rejected:      'bg-rose-100    text-rose-800    border-rose-200',
  reclassified:  'bg-violet-100  text-violet-800  border-violet-200',
};

export const PII_CATEGORY_COLOURS: Record<string, string> = {
  NAME:         'bg-sky-100    text-sky-800',
  EMAIL:        'bg-violet-100 text-violet-800',
  PHONE:        'bg-teal-100   text-teal-800',
  ADDRESS:      'bg-orange-100 text-orange-800',
  DOB:          'bg-pink-100   text-pink-800',
  GENDER:       'bg-fuchsia-100 text-fuchsia-800',
  AADHAAR:      'bg-red-100    text-red-800',
  PAN:          'bg-amber-100  text-amber-800',
  BANK_ACCOUNT: 'bg-emerald-100 text-emerald-800',
  USER_ID:      'bg-indigo-100  text-indigo-800',
  CREDENTIAL:   'bg-rose-100   text-rose-800',
};

export const PII_CATEGORIES = [
  'NAME','EMAIL','PHONE','ADDRESS','DOB','GENDER',
  'AADHAAR','PAN','BANK_ACCOUNT','USER_ID','CREDENTIAL',
];
