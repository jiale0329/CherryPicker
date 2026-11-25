import * as React from 'react';

import { cn } from '@/lib/utils';

/** Labelled form row with optional hint and validation message. */
export function Field({
  label,
  hint,
  error,
  htmlFor,
  children,
  className,
}: {
  label: string;
  hint?: string;
  error?: string;
  htmlFor?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('space-y-1.5', className)}>
      <label htmlFor={htmlFor} className="block text-xs font-medium text-foreground">
        {label}
      </label>
      {children}
      {error ? (
        <p className="text-xs" style={{ color: 'var(--status-failed)' }}>
          {error}
        </p>
      ) : hint ? (
        <p className="text-xs leading-snug text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  );
}

export function TextInput({ className, ...props }: React.ComponentProps<'input'>) {
  return (
    <input
      className={cn(
        'h-9 w-full rounded-md border border-border-strong bg-surface-raised px-2.5 text-sm',
        'outline-none placeholder:text-muted-foreground/70 focus-visible:ring-2 focus-visible:ring-ring/60',
        'disabled:cursor-not-allowed disabled:opacity-60',
        className,
      )}
      {...props}
    />
  );
}

export function TextArea({ className, ...props }: React.ComponentProps<'textarea'>) {
  return (
    <textarea
      className={cn(
        'w-full rounded-md border border-border-strong bg-surface-raised px-2.5 py-2 text-sm',
        'font-mono outline-none placeholder:text-muted-foreground/70 focus-visible:ring-2 focus-visible:ring-ring/60',
        className,
      )}
      {...props}
    />
  );
}

export function CheckboxRow({
  label,
  hint,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label
      className={cn(
        'flex cursor-pointer items-start gap-2.5',
        disabled && 'cursor-not-allowed opacity-60',
      )}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        className="mt-0.5 size-4 cursor-pointer accent-primary"
      />
      <span className="min-w-0">
        <span className="block text-xs font-medium text-foreground">{label}</span>
        {hint ? <span className="mt-0.5 block text-xs text-muted-foreground">{hint}</span> : null}
      </span>
    </label>
  );
}
