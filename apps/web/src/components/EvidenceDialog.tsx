import { Icon } from '../lib/common.js'
import React, { useRef, useEffect } from 'react'

export function EvidenceDialog({
  title,
  close,
  children
}: {
  title: string
  close: () => void
  children: React.ReactNode
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const returnFocus = useRef<HTMLElement | null>(null)
  useEffect(() => {
    returnFocus.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null
    dialog.current?.showModal()
    return () => returnFocus.current?.focus()
  }, [])
  return (
    <dialog
      ref={dialog}
      className="evidence-dialog"
      aria-labelledby="evidence-title"
      onCancel={(event) => {
        event.preventDefault()
        close()
      }}
      onClick={(event) => {
        if (event.target === dialog.current) close()
      }}
    >
      <div className="dialog-heading">
        <div>
          <span className="eyebrow">RECORDED EVIDENCE</span>
          <h2 id="evidence-title">{title}</h2>
        </div>
        <button aria-label="Close evidence" className="icon-button" onClick={close}>
          <Icon name="close" />
        </button>
      </div>
      <div className="dialog-content">{children}</div>
    </dialog>
  )
}
