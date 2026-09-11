import { useId, useLayoutEffect, useRef, type HTMLAttributes } from 'react'

const stack: HTMLElement[] = []
const focusable = 'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/** Shared modal focus lifecycle, including nested dialogs and focus restoration. */
export function Dialog({ onClose, children, ...props }: HTMLAttributes<HTMLDivElement> & { onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const opener = useRef(typeof document === 'undefined' ? null : document.activeElement as HTMLElement | null)
  const close = useRef(onClose)
  close.current = onClose
  const titleId = useId()
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const heading = el.querySelector('h1, h2, h3')
    if (!el.hasAttribute('aria-label') && heading) {
      if (!heading.id) heading.id = titleId
      el.setAttribute('aria-labelledby', heading.id)
    }
    stack.push(el)
    const candidates = () => [...el.querySelectorAll<HTMLElement>(focusable)]
      .filter(node => node.tabIndex >= 0 && !node.closest('[hidden], [inert]') && node.getClientRects().length > 0)
    const focusFirst = () => (candidates()[0] ?? el).focus()
    if (!el.contains(document.activeElement)) focusFirst()
    const onKey = (event: KeyboardEvent) => {
      if (stack.at(-1) !== el) return
      if (event.key === 'Tab') {
        const nodes = candidates()
        const index = nodes.indexOf(document.activeElement as HTMLElement)
        if (nodes.length === 0 || index < 0 || (event.shiftKey ? index === 0 : index === nodes.length - 1)) {
          event.preventDefault()
          ;(event.shiftKey ? nodes.at(-1) ?? el : nodes[0] ?? el).focus()
        }
      }
    }
    const onFocus = (event: FocusEvent) => {
      if (stack.at(-1) === el && !el.contains(event.target as Node)) focusFirst()
    }
    document.addEventListener('keydown', onKey, true)
    document.addEventListener('focusin', onFocus)
    return () => {
      const wasTop = stack.at(-1) === el
      const index = stack.indexOf(el)
      if (index >= 0) stack.splice(index, 1)
      document.removeEventListener('keydown', onKey, true)
      document.removeEventListener('focusin', onFocus)
      if (wasTop && opener.current?.isConnected) opener.current.focus()
    }
  }, [titleId])
  return <div {...props} ref={ref} role="dialog" aria-modal="true" tabIndex={-1} onKeyDown={event => {
    props.onKeyDown?.(event)
    if (event.key === 'Escape' && !event.defaultPrevented && stack.at(-1) === ref.current) {
      event.preventDefault()
      event.stopPropagation()
      close.current()
    }
  }}>{children}</div>
}
