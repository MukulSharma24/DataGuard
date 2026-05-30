import { cn } from '@/lib/utils';
import { HTMLAttributes } from 'react';

interface SkeletonProps extends HTMLAttributes<HTMLDivElement> {
  className?: string;
}

export function Skeleton({ className, ...props }: SkeletonProps) {
  return <div className={cn('skeleton rounded-md', className)} {...props} />;
}

export function SkeletonStatCard() {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-card">
      <Skeleton className="w-9 h-9 rounded-lg mb-4" />
      <Skeleton className="h-7 w-14 mb-2" />
      <Skeleton className="h-3 w-24" />
    </div>
  );
}

export function SkeletonRow() {
  return (
    <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100 last:border-0">
      <div className="flex-1 space-y-2">
        <Skeleton className="h-3.5 w-1/3" />
        <Skeleton className="h-3 w-1/2" />
      </div>
      <div className="flex gap-2 ml-4">
        <Skeleton className="h-5 w-16 rounded-full" />
        <Skeleton className="h-5 w-12 rounded-full" />
      </div>
    </div>
  );
}

export function SkeletonCard() {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-card">
      <div className="flex items-start justify-between mb-3">
        <div className="space-y-2 flex-1">
          <Skeleton className="h-3.5 w-3/5" />
          <Skeleton className="h-3 w-2/5" />
        </div>
        <Skeleton className="h-5 w-16 rounded-full ml-3" />
      </div>
      <div className="flex items-center justify-between mt-4 pt-3 border-t border-slate-100">
        <Skeleton className="h-3 w-20" />
        <Skeleton className="h-3 w-16" />
      </div>
    </div>
  );
}
