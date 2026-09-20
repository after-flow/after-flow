import { Link } from 'react-router-dom'
import type { InheritanceDecisionSummary } from '@aftercare/public-contracts'
import { useCaseOverview } from '@/lib/api/queries'
import { Banner } from '@/components/ui/Banner'
import { Term } from '@/components/ui/Term'
import { formatDate } from '@/lib/format'

/**
 * 放棄前ロック（企画書セクション5／仕様書セクション3・5・6・7）。
 *
 * 相続方法が未確定（Decision が未登録）の間は
 *  - 財産処分・現金化に相当する操作導線を表示しない
 *  - 常時表示の警告バナーを出す（閉じるボタンは付けない）
 */
export function useRenunciationLock(caseId: string): {
  locked: boolean
  decision?: InheritanceDecisionSummary
} {
  const { data } = useCaseOverview(caseId)
  return {
    // 取得前は安全側に倒してロック扱いにする
    locked: data ? !data.inheritanceDecision.decided : true,
    decision: data?.inheritanceDecision,
  }
}

export function RenunciationLockBanner({
  caseId,
  decision,
}: {
  caseId: string
  decision?: InheritanceDecisionSummary
}) {
  const undecided = decision?.perHeir.filter((h) => h.method == null) ?? []

  return (
    /*
      常時表示・閉じるボタンなしは維持しつつ、要点だけを出す。
      以前は初回に画面の半分をこの警告が占め、いちばん急ぐ手続きが見えなかった。
      背景の説明は「くわしく」に畳み、重要な一文と期限は常に見えるようにしている。
    */
    <Banner tone="critical" title="故人の預金や財産に手をつけないでください" role="alert">
      <p>
        <Term word="相続放棄" />
        ができなくなるおそれがあります。相続の方法が決まるまでお待ちください。
      </p>

      <p className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-sm">
        {decision?.deliberationDeadline && (
          <span>
            判断の期限：<strong>{formatDate(decision.deliberationDeadline)}</strong>
          </span>
        )}
        {undecided.length > 0 && (
          <span>
            未確定：
            {undecided.length <= 2
              ? undecided.map((h) => h.personName).join('、')
              : `${undecided[0].personName} ほか${undecided.length - 1}名`}
          </span>
        )}
      </p>

      <details className="mt-1.5">
        <summary className="cursor-pointer text-sm font-bold underline">くわしく</summary>
        <p className="mt-1.5 text-sm">
          故人の預金を使う、財産を処分する、借金を返済するといった行為があると、
          <Term word="単純承認" />
          をしたものとみなされ、あとから放棄できなくなることがあります。判断の期限は
          <Term word="熟慮期間" />
          と呼ばれ、家庭裁判所に申し立てて延ばせる場合もあります。判断に迷われる場合は、先に弁護士へご相談ください。
        </p>
      </details>

      <p className="mt-2">
        <Link className="font-bold underline" to={`/cases/${caseId}/family`}>
          相続人ごとの判断状況を確認する
        </Link>
      </p>
    </Banner>
  )
}

/** ロック中に、隠している導線の代わりに表示する説明 */
export function LockedActionNotice({ caseId }: { caseId: string }) {
  return (
    <Banner tone="warning" title="一部の操作は相続方法が決まるまで表示していません">
      <p className="text-sm">
        財産の処分・解約にあたる操作は、
        <Term word="相続放棄" />
        の判断が確定してから表示します。いまは確認と記録のみ行えます。{' '}
        <Link className="font-bold underline" to={`/cases/${caseId}/family`}>
          判断状況を確認する
        </Link>
      </p>
    </Banner>
  )
}
