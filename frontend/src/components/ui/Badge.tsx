import { cn } from '@/lib/utils';

interface BadgeProps {
  label: string;
  className?: string;
  size?: 'sm' | 'md';
  dot?: boolean;
}

export function Badge({ label, className, size = 'md', dot }: BadgeProps) {
  return (
    <span className={cn(
      'inline-flex items-center gap-1.5 rounded-full border font-medium leading-none',
      size === 'sm' ? 'px-2 py-1 text-[10px]' : 'px-2.5 py-1 text-xs',
      className
    )}>
      {dot && (
        <span className="w-1.5 h-1.5 rounded-full bg-current opacity-70 shrink-0" />
      )}
      {label}
    </span>
  );
}
