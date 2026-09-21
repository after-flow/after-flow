import { Link, useNavigate, useParams } from 'react-router-dom'
import { Icon } from '@/kit/Icon'
import { Button, Notice } from '@/kit/kit'
import { LEGAL_DOCS, legalDocId } from '@/lib/legalDocs'
import { LegalBody } from './parts/LegalBody'
import { Centered, Logo } from './parts/EntryLayout'

const TABS = [
  { id: 'terms', label: '利用規約' },
  { id: 'privacy', label: '個人情報の取扱い' },
]

/**
 * 利用規約・個人情報の取扱いの表示。本文は lib/legalDocs.ts に置いている。
 * 同意の画面からはダイアログで開くので、ここへはサイドバーの下のリンクや、URL を直接開いたときに来る。
 */
export function LegalScreen() {
  const navigate = useNavigate()
  const { docId = 'terms' } = useParams()
  const id = legalDocId(docId) ?? 'terms'
  const doc = LEGAL_DOCS[id]

  // 同意画面からもアプリ内のどこからでも開かれるので、元いた場所へ戻す。
  // 直接開かれて戻り先が無いときは、手続きの画面へ。
  const goBack = () => {
    const idx = (window.history.state as { idx?: number } | null)?.idx ?? 0
    if (idx > 0) navigate(-1)
    else navigate('/cases')
  }

  return (
    <Centered wide="doc">
      <div className="flex items-center justify-between">
        <Logo />
        <button
          type="button"
          onClick={goBack}
          className="inline-flex h-10 items-center gap-0.5 rounded-md px-2 text-[0.94rem] font-bold text-rd-text-2 hover:bg-rd-shade hover:text-rd-text"
        >
          <Icon name="chevron-left" size={17} />
          戻る
        </button>
      </div>

      <nav aria-label="文書の切り替え" className="mt-6 flex gap-1 border-b border-rd-border">
        {TABS.map((t) => (
          <Link
            key={t.id}
            to={`/legal/${t.id}`}
            replace
            aria-current={t.id === id ? 'page' : undefined}
            className={`-mb-px flex h-11 items-center border-b-2 px-3 text-[0.94rem] font-bold ${
              t.id === id
                ? 'border-rd-primary text-rd-primary-text'
                : 'border-transparent text-rd-text-2 hover:text-rd-text'
            }`}
          >
            {t.label}
          </Link>
        ))}
      </nav>

      <header className="mt-5">
        <h1 className="text-[1.35rem] font-bold">{doc.title}</h1>
        <p className="mt-0.5 text-[0.86rem] text-rd-text-3">最終更新：{doc.updatedAt}</p>
      </header>

      <div className="mt-4 flex flex-col gap-4">
        <Notice tone="warning" title="この文面は確定していません">
          本文は仮置きです。弁護士による作成・確認を経て差し替えます。「要確定」の印がある箇所は、収益モデルや専門家紹介の対価など、方針が決まっていない事項です。
        </Notice>

        <LegalBody doc={doc} />

        {/* 長い文書を読み終えたところで、上まで戻らずに元の画面へ戻れるようにする */}
        <div className="flex justify-center pt-2 pb-4">
          <Button size="lg" icon="chevron-left" onClick={goBack}>
            戻る
          </Button>
        </div>
      </div>
    </Centered>
  )
}
