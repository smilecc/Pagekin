import type { ReactNode } from 'react'

export function WritingOptionsSectionHeader({ numeral, title, description, status }: {
  numeral: string
  title: string
  description: string
  status?: ReactNode
}) {
  return (
    <header className="writing-options-section-head">
      <div>
        <h2><span aria-hidden>{numeral}</span>{title}</h2>
        <p>{description}</p>
      </div>
      {status}
    </header>
  )
}
