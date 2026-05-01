import { useState, useEffect, useRef } from "react";

interface Org {
  slug: string;
  displayName: string;
}

interface UserMenuProps {
  slug: string;
  orgs?: Org[];
}

export default function UserMenu({ slug, orgs = [] }: UserMenuProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const hideTimeout = useRef<ReturnType<typeof setTimeout>>(undefined);

  function show() {
    clearTimeout(hideTimeout.current);
    setOpen(true);
  }

  function scheduleHide() {
    hideTimeout.current = setTimeout(() => setOpen(false), 150);
  }

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("click", handleClickOutside);
    return () => document.removeEventListener("click", handleClickOutside);
  }, []);

  return (
    <div
      ref={rootRef}
      className="relative"
      onMouseEnter={show}
      onMouseLeave={scheduleHide}
    >
      <button
        className="hover:text-ink transition-colors font-medium text-ink cursor-pointer"
        type="button"
        onClick={() => setOpen((v) => !v)}
      >
        {slug} ▾
      </button>
      {open && (
        <div className="absolute right-0 top-full pt-1 z-50">
          <div className="bg-parchment border border-rule shadow-sm min-w-48">
            <a
              href={`/${slug}`}
              className="block px-3 py-2 text-sm text-ink-light hover:bg-parchment-dark transition-colors"
            >
              Your Profile
            </a>
            <a
              href="/dashboard"
              className="block px-3 py-2 text-sm text-ink-light hover:bg-parchment-dark transition-colors"
            >
              Dashboard
            </a>
            <a
              href="/settings"
              className="block px-3 py-2 text-sm text-ink-light hover:bg-parchment-dark transition-colors"
            >
              Settings
            </a>
            {orgs.length > 0 && (
              <>
                <hr className="border-rule" />
                <p className="px-3 pt-2 pb-1 text-[10px] uppercase tracking-wide text-ink-muted font-semibold">
                  Your organizations
                </p>
                {orgs.map((org) => (
                  <a
                    key={org.slug}
                    href={`/${org.slug}`}
                    className="block px-3 py-1.5 text-sm text-ink-light hover:bg-parchment-dark transition-colors"
                  >
                    {org.displayName}
                  </a>
                ))}
              </>
            )}
            <hr className="border-rule" />
            <a
              href="/logout"
              className="block px-3 py-2 text-sm text-ink-muted hover:bg-parchment-dark transition-colors"
            >
              Sign out
            </a>
          </div>
        </div>
      )}
    </div>
  );
}
