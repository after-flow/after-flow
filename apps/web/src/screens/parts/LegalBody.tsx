import type { LegalDoc } from '@/lib/legalDocs'

/** 規約などの条文。「要確定」の印がある段落は、未確定だと分かるよう色を変える */
export function LegalBody({ doc, bordered = true }: { doc: LegalDoc; bordered?: boolean }) {
  return (
    <article className={bordered ? 'rounded-lg border border-rd-border bg-rd-card' : ''}>
      {doc.sections.map((sec) => (
        <section
          key={sec.heading}
          className={`border-b border-rd-border-2 py-4 last:border-b-0 ${bordered ? 'px-5' : 'first:pt-0 last:pb-0'}`}
        >
          <h2 className="text-[1rem] font-bold">{sec.heading}</h2>
          <div className="mt-2 flex flex-col gap-2 text-[0.94rem] leading-relaxed">
            {sec.body.map((p, i) =>
              p.startsWith('【要確定】') ? (
                <p key={i} className="rounded-md bg-rd-warning-soft px-3 py-2 text-rd-warning-text">
                  <span className="mr-1.5 inline-block rounded bg-rd-card px-1.5 text-[0.8rem] font-bold">要確定</span>
                  {p.replace('【要確定】', '')}
                </p>
              ) : (
                <p key={i}>{p}</p>
              ),
            )}
          </div>
        </section>
      ))}
    </article>
  )
}
