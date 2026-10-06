import { useEffect, type RefObject } from 'react'

/**
 * Closes a popover (menu, dropdown, modal) on outside click or Escape, and
 * returns focus to whatever opened it. Keyboard users can always get out.
 */
export function useDismissable(
  open: boolean,
  onClose: () => void,
  ref: RefObject<HTMLElement | null>,
) {
  useEffect(() => {
    if (!open) return

    // Remember the trigger so focus can return to it on close.
    const previouslyFocused = document.activeElement as HTMLElement | null

    function handlePointer(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
        previouslyFocused?.focus?.()
      }
    }

    document.addEventListener('mousedown', handlePointer)
    document.addEventListener('keydown', handleKey)
    return () => {
      document.removeEventListener('mousedown', handlePointer)
      document.removeEventListener('keydown', handleKey)
    }
  }, [open, onClose, ref])
}
