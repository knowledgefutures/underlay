import { Link } from 'react-router'

import { TokenLink } from '~/lib/share-token'

/**
 * Shared UI primitives. One visual voice for the whole app:
 * - controls (buttons, inputs, chips, menus) round at --radius-control (4px)
 * - surfaces (tables, panels, alerts) round at --radius-surface (2px)
 * - one hover treatment per variant, one disabled treatment, 100ms color transitions
 * - keyboard focus comes from the global :focus-visible rule in global.css
 */

// ---------------------------------------------------------------- Button

export type ButtonVariant =
  | 'primary'
  | 'secondary'
  | 'danger'
  | 'success'
  | 'ghost'
  | 'link'
  | 'dangerLink'
/** `lg` is for hero/landing calls to action, not general page actions. */
export type ButtonSize = 'sm' | 'md' | 'lg'

const solidButtonBase =
  'inline-flex cursor-pointer items-center justify-center gap-1.5 rounded-control transition-colors disabled:pointer-events-none disabled:opacity-50'
const textButtonBase =
  'inline-flex cursor-pointer items-center gap-1 rounded-control transition-colors disabled:pointer-events-none disabled:opacity-50'

const buttonVariants: Record<ButtonVariant, string> = {
  primary: `${solidButtonBase} bg-ink text-parchment font-medium hover:bg-ink-light`,
  secondary: `${solidButtonBase} border border-rule bg-parchment text-ink hover:bg-parchment-dark`,
  danger: `${solidButtonBase} bg-red-700 font-medium text-white hover:bg-red-800`,
  // For affirmative actions that must read as distinct from the neutral primary
  // (approve, accept) — not for general submit buttons.
  success: `${solidButtonBase} bg-green-700 font-medium text-white hover:bg-green-800`,
  ghost: `${textButtonBase} text-ink-muted hover:text-ink`,
  link: `${textButtonBase} text-link hover:underline`,
  dangerLink: `${textButtonBase} text-red-700 hover:underline`,
}

const solidButtonSizes: Record<ButtonSize, string> = {
  sm: 'px-3 py-1.5 text-xs',
  md: 'px-4 py-2 text-sm',
  lg: 'px-5 py-2.5 text-sm',
}
const textButtonSizes: Record<ButtonSize, string> = {
  sm: 'text-xs',
  md: 'text-sm',
  lg: 'text-base',
}

export function buttonClasses(
  variant: ButtonVariant = 'primary',
  size: ButtonSize = 'md',
  className?: string,
): string {
  const isText = variant === 'ghost' || variant === 'link' || variant === 'dangerLink'
  const sizes = isText ? textButtonSizes[size] : solidButtonSizes[size]
  return `${buttonVariants[variant]} ${sizes}${className ? ` ${className}` : ''}`
}

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
}

export function Button({
  variant = 'primary',
  size = 'md',
  className,
  type,
  ...rest
}: ButtonProps) {
  return (
    <button type={type ?? 'button'} className={buttonClasses(variant, size, className)} {...rest} />
  )
}

interface ButtonLinkProps extends React.ComponentProps<typeof Link> {
  variant?: ButtonVariant
  size?: ButtonSize
  /** Carry the collection share token across navigation (TokenLink). */
  token?: boolean
}

export function ButtonLink({
  variant = 'primary',
  size = 'md',
  className,
  token,
  ...rest
}: ButtonLinkProps) {
  const Component = token ? TokenLink : Link
  // Solid variants need the visited color pinned: global CSS sets a:visited to inherit.
  const visited =
    variant === 'primary'
      ? 'visited:text-parchment'
      : variant === 'danger'
        ? 'visited:text-white'
        : ''
  const combined = visited ? `${visited}${className ? ` ${className}` : ''}` : className
  return <Component className={buttonClasses(variant, size, combined)} {...rest} />
}

// ---------------------------------------------------------------- Form controls

export const inputClasses =
  'w-full rounded-control border border-rule bg-parchment px-3 py-2 text-sm focus:border-ink focus:outline-none'

export function Input({ className, ...rest }: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input className={className ? `${inputClasses} ${className}` : inputClasses} {...rest} />
}

export function Select({ className, ...rest }: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={`${inputClasses} cursor-pointer${className ? ` ${className}` : ''}`}
      {...rest}
    />
  )
}

export function Textarea({
  className,
  resize = 'none',
  ...rest
}: React.TextareaHTMLAttributes<HTMLTextAreaElement> & {
  /** 'y' allows vertical dragging; default is a fixed height. */
  resize?: 'none' | 'y'
}) {
  return (
    <textarea
      className={`${inputClasses} ${resize === 'y' ? 'resize-y' : 'resize-none'}${className ? ` ${className}` : ''}`}
      {...rest}
    />
  )
}

export function Checkbox({ className, ...rest }: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input type="checkbox" className={`accent-ink${className ? ` ${className}` : ''}`} {...rest} />
  )
}

interface FieldProps {
  label: React.ReactNode
  htmlFor?: string
  hint?: React.ReactNode
  className?: string
  children: React.ReactNode
}

/** A labeled form control with an optional hint line below. */
export function Field({ label, htmlFor, hint, className, children }: FieldProps) {
  return (
    <div className={className}>
      <label htmlFor={htmlFor} className="text-ink mb-1.5 block text-sm font-medium">
        {label}
      </label>
      {children}
      {hint && <p className="text-ink-muted mt-1 text-xs">{hint}</p>}
    </div>
  )
}

// ---------------------------------------------------------------- Alert

type AlertVariant = 'success' | 'error' | 'info'

const alertVariants: Record<AlertVariant, string> = {
  success: 'border-green-200 bg-green-50 text-green-800',
  error: 'border-red-200 bg-red-50 text-red-700',
  info: 'border-rule bg-parchment-dark/40 text-ink-light',
}

export function Alert({
  variant = 'info',
  className,
  children,
}: {
  variant?: AlertVariant
  className?: string
  children: React.ReactNode
}) {
  return (
    <div
      className={`rounded-surface border px-3 py-2 text-sm ${alertVariants[variant]}${className ? ` ${className}` : ''}`}
    >
      {children}
    </div>
  )
}

// ---------------------------------------------------------------- Table

interface TableProps {
  className?: string
  /** text-xs instead of text-sm; for dense data tables like records. */
  dense?: boolean
  children: React.ReactNode
}

/** Bordered, horizontally scrollable table container. Children: thead/tbody built from Th/Td/Tr. */
export function Table({ className, dense, children }: TableProps) {
  return (
    <div
      className={`border-rule rounded-surface overflow-x-auto border${className ? ` ${className}` : ''}`}
    >
      <table className={`w-full ${dense ? 'text-xs' : 'text-sm'}`}>{children}</table>
    </div>
  )
}

export function Th({ className, ...rest }: React.ThHTMLAttributes<HTMLTableCellElement>) {
  return (
    <th
      className={`border-rule bg-parchment-dark text-ink-muted border-b px-2.5 py-2 text-left text-xs font-medium${className ? ` ${className}` : ''}`}
      {...rest}
    />
  )
}

export function Td({ className, ...rest }: React.TdHTMLAttributes<HTMLTableCellElement>) {
  return (
    <td
      className={`border-rule border-b px-2.5 py-2 align-top${className ? ` ${className}` : ''}`}
      {...rest}
    />
  )
}

export function Tr({ className, ...rest }: React.HTMLAttributes<HTMLTableRowElement>) {
  return (
    <tr
      className={`hover:bg-parchment-dark/50 transition-colors${className ? ` ${className}` : ''}`}
      {...rest}
    />
  )
}

// ---------------------------------------------------------------- Tabs

export interface TabItem {
  label: React.ReactNode
  /** Renders a link when set; use onClick for state-driven tabs. */
  to?: string
  onClick?: () => void
  active?: boolean
  /** Push this item (and those after it) to the right edge. */
  right?: boolean
  /** Carry the collection share token (TokenLink) instead of a plain Link. */
  token?: boolean
}

const tabBase = '-mb-px border-b-2 px-3 py-2 text-sm font-medium transition-colors'
export const tabActiveClasses = `${tabBase} border-ink text-ink`
export const tabInactiveClasses = `${tabBase} border-transparent text-ink-muted hover:border-rule hover:text-ink`

export function Tabs({
  items,
  className,
  children,
}: {
  items: TabItem[]
  className?: string
  /** Extra content on the right edge of the bar (e.g. a version picker). */
  children?: React.ReactNode
}) {
  return (
    <div
      className={`border-rule mb-6 flex items-center border-b${className ? ` ${className}` : ''}`}
    >
      {items.map((item, i) => {
        const classes = `${item.active ? tabActiveClasses : tabInactiveClasses}${item.right ? ' ml-auto' : ''}`
        if (item.to) {
          const Component = item.token ? TokenLink : Link
          return (
            <Component key={i} to={item.to} className={classes}>
              {item.label}
            </Component>
          )
        }
        return (
          <button
            key={i}
            type="button"
            onClick={item.onClick}
            className={`${classes} cursor-pointer`}
          >
            {item.label}
          </button>
        )
      })}
      {children}
    </div>
  )
}

// ---------------------------------------------------------------- Text & structure

/** Page title: the one h1 style. */
export function PageTitle({
  className,
  children,
}: {
  className?: string
  children: React.ReactNode
}) {
  return (
    <h1 className={`mb-6 text-xl font-semibold tracking-tight${className ? ` ${className}` : ''}`}>
      {children}
    </h1>
  )
}

/** Uppercase section eyebrow: the one h2 style for in-page sections. */
export function SectionHeading({
  className,
  children,
}: {
  className?: string
  children: React.ReactNode
}) {
  return (
    <h2
      className={`text-ink-muted mb-3 text-sm font-semibold tracking-wide uppercase${className ? ` ${className}` : ''}`}
    >
      {children}
    </h2>
  )
}

export function Badge({
  className,
  title,
  children,
}: {
  className?: string
  title?: string
  children: React.ReactNode
}) {
  return (
    <span
      title={title}
      className={`border-rule text-ink-muted rounded-control inline-flex items-center border px-1.5 py-px font-mono text-[10px]${className ? ` ${className}` : ''}`}
    >
      {children}
    </span>
  )
}

export function EmptyState({
  className,
  children,
}: {
  className?: string
  children: React.ReactNode
}) {
  return (
    <div
      className={`border-rule text-ink-muted rounded-surface border px-4 py-8 text-center text-sm${className ? ` ${className}` : ''}`}
    >
      {children}
    </div>
  )
}
