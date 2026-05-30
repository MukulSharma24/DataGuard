import { cn } from '@/lib/utils';
import { ReactNode, ButtonHTMLAttributes } from 'react';

type Variant = 'primary' | 'secondary' | 'danger' | 'ghost' | 'success';
type Size    = 'sm' | 'md' | 'lg';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  children: ReactNode;
}

const VARIANTS: Record<Variant, string> = {
  primary:
    'bg-indigo-600 text-white border-transparent shadow-sm shadow-indigo-600/20 ' +
    'hover:bg-indigo-700 hover:shadow-md hover:shadow-indigo-600/25 active:bg-indigo-800',
  secondary:
    'bg-white text-slate-700 border-slate-200 shadow-sm ' +
    'hover:bg-slate-50 hover:border-slate-300 active:bg-slate-100',
  danger:
    'bg-rose-600 text-white border-transparent shadow-sm shadow-rose-600/15 ' +
    'hover:bg-rose-700 active:bg-rose-800',
  ghost:
    'bg-transparent text-slate-600 border-transparent ' +
    'hover:bg-slate-100 hover:text-slate-700 active:bg-slate-200',
  success:
    'bg-emerald-600 text-white border-transparent shadow-sm shadow-emerald-600/15 ' +
    'hover:bg-emerald-700 active:bg-emerald-800',
};

const SIZES: Record<Size, string> = {
  sm: 'px-3 py-1.5 text-xs h-8',
  md: 'px-4 py-2 text-sm h-9',
  lg: 'px-5 py-2.5 text-sm h-10',
};

export function Button({
  variant = 'primary',
  size = 'md',
  loading = false,
  className,
  disabled,
  children,
  ...props
}: ButtonProps) {
  return (
    <button
      disabled={disabled || loading}
      className={cn(
        'inline-flex items-center justify-center gap-1.5 rounded-lg border font-medium',
        'transition-all duration-150',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/50 focus-visible:ring-offset-2',
        'disabled:opacity-50 disabled:cursor-not-allowed disabled:shadow-none',
        'select-none whitespace-nowrap',
        VARIANTS[variant],
        SIZES[size],
        className
      )}
      {...props}
    >
      {loading && (
        <svg className="animate-spin h-3.5 w-3.5 shrink-0" fill="none" viewBox="0 0 24 24">
          <circle className="opacity-20" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
        </svg>
      )}
      {children}
    </button>
  );
}
