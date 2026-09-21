import { Link, useNavigate, useParams } from 'react-router-dom'
import { Icon } from '@/kit/Icon'
import { Notice } from '@/kit/kit'
import { Centered, Logo } from './parts/EntryLayout'

/**
 * 利用規約・個人情報の取扱いの表示。
 *
 * 本文はすべて仮置き。文面は弁護士による作成・確認を経て差し替える前提で、
 * ここでは画面と導線だけを用意している。
 * 未確定の項目（収益モデル、専門家紹介の対価）が決まらないと確定できない箇所には
 * 【要確定】を付けてある。
 */
const DOCS: Record<
  string,
  { title: string; updatedAt: string; sections: { heading: string; body: string[] }[] }
> = {
  terms: {
    title: '利用規約',
    updatedAt: '未確定（法務確認待ち）',
    sections: [
      {
        heading: '第1条（本サービスの内容）',
        body: [
          '本サービスは、ご家族を亡くされた方が行う手続きについて、必要な手続きの整理、期限の管理、提出先・持ち物・手順のご案内を行うものです。',
          '本サービスは、法律事務、税務代理、税務相談、登記手続の代理、官公署に提出する書類の作成その他の法令上の資格を要する業務を行いません。',
          '役所・金融機関その他の外部機関への申請、届出、送信、解約、支払いは、すべて利用者ご自身が行うものとします。当社がこれらを代行することはありません。',
        ],
      },
      {
        heading: '第2条（AIによる情報整理について）',
        body: [
          '本サービスは、アップロードされた書類の内容をAIが解析し、手続きや財産・契約の候補を提示します。',
          'AIによる検出は網羅性を保証するものではありません。表示されていない財産・契約・手続きが存在する可能性があります。',
          'AIが提示する内容は情報の整理であり、法的又は税務的な判断ではありません。',
        ],
      },
      {
        heading: '第3条（利用者の確認義務）',
        body: [
          '手続きの完了の判定は、利用者ご自身の確認によるものとします。',
          '窓口、必要書類、受付時間等のご案内は、公開情報をもとに作成していますが、変更されている場合があります。お手続きの前に、提出先の機関へ直接ご確認ください。',
        ],
      },
      {
        heading: '第4条（免責）',
        body: [
          '【要確定】当社の責任範囲については、消費者契約法その他の法令に照らして有効な範囲で定めます。責任を全部免除する定めは置きません。',
        ],
      },
      {
        heading: '第5条（専門家のご紹介）',
        body: [
          '【要確定】専門家をご紹介する場合の対価の有無について、方針決定後に記載します。対価を受け取る場合は、ご紹介の画面においてその旨を開示します。',
        ],
      },
      {
        heading: '第6条（料金）',
        body: ['【要確定】収益モデルの決定後に記載します。'],
      },
    ],
  },
  privacy: {
    title: '個人情報の取扱いについて',
    updatedAt: '未確定（法務確認待ち）',
    sections: [
      {
        heading: '1. 取得する情報',
        body: [
          'お客様の氏名・連絡先、故人との続柄、ご逝去日、手続き先の市区町村。',
          'アップロードいただいた書類およびその解析結果。',
          '相続人その他の関係者として登録された方の氏名・続柄・連絡先。',
        ],
      },
      {
        heading: '2. 利用目的',
        body: [
          '必要な手続きの洗い出し、期限の計算と通知、提出先・持ち物のご案内のため。',
          '手続きの進捗管理および完了の記録のため。',
          '【要確定】第三者（相続人以外の関係者）の情報を登録いただく場合の、ご本人への利用目的の通知方法について定めます。',
        ],
      },
      {
        heading: '3. マイナンバーについて',
        body: [
          'マイナンバーが記載された書類はお預かりしません。アップロード時に検知した場合は保存せずにお断りするか、該当箇所を隠して保存します。',
        ],
      },
      {
        heading: '4. 外部のAI事業者への提供',
        body: [
          '書類の解析およびご案内の作成にあたり、外部のAI事業者に情報を提供します。',
          '【要確定】提供先事業者名、提供する情報の範囲、委託又は第三者提供のいずれに当たるかを記載します。',
          '【要確定】提供先が外国にある場合、個人情報保護法第28条に基づき、移転先の国名および当該国の個人情報保護制度に関する情報を記載したうえで、別途同意をいただきます。',
        ],
      },
      {
        heading: '5. 保存期間・削除',
        body: ['【要確定】保存期間と削除のご請求方法について記載します。'],
      },
    ],
  },
}

const TABS = [
  { id: 'terms', label: '利用規約' },
  { id: 'privacy', label: '個人情報の取扱い' },
]

export function LegalScreen() {
  const navigate = useNavigate()
  const { docId = 'terms' } = useParams()
  const id = DOCS[docId] ? docId : 'terms'
  const doc = DOCS[id]

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

        <article className="rounded-lg border border-rd-border bg-rd-card">
          {doc.sections.map((sec) => (
            <section key={sec.heading} className="border-b border-rd-border-2 px-5 py-4 last:border-b-0">
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
      </div>
    </Centered>
  )
}
