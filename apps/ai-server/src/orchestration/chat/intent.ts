export type ChatIntent =
  | 'out_of_scope'
  | 'delegated_action'
  | 'burial_benefit'
  | 'death_notification'
  | 'pension'
  | 'inheritance_renunciation'
  | 'final_income_tax'
  | 'inheritance_tax'
  | 'real_estate_registration'
  | 'priority_overview'
  | 'aftercare_general'

const AFTERCARE = /死亡届|埋葬|葬儀|火葬|納骨|墓地|遺品|形見|年金|相続|遺産|遺言|遺産分割|相続人|準確定申告|相続税|相続登記|健康保険|介護保険|遺族|故人|死亡後|死亡保険金|生命保険|口座凍結|未支給年金|亡くな.{0,36}(?:手続|申請|届|解約|相続|保険|年金|名義|優先|準備|口座|契約|税|家|土地|財産|借金|ローン|カード|携帯|電気|ガス|水道|何|どう|すべ)/u
const DELEGATED_ACTION = /(?:代わりに|そちらで|あなたが|AIが).{0,30}(?:提出|申請|届出|連絡|解約|送金|支払|予約|変更).{0,12}(?:して|お願い|ください|おいて)/u

/**
 * A deterministic boundary runs before research. It prevents unrelated prompts
 * from consuming provider calls and keeps requests for real-world actions out of
 * the answer-generation path.
 */
export function classifyChatIntent(message: unknown): ChatIntent {
  if (typeof message !== 'string') return 'out_of_scope'
  const value = message.normalize('NFKC').replace(/\s+/g, ' ').trim()
  if (!value || !AFTERCARE.test(value)) return 'out_of_scope'
  if (DELEGATED_ACTION.test(value)) return 'delegated_action'
  if (/協会けんぽ|全国健康保険協会|埋葬料|埋葬費|家族埋葬料/u.test(value)) return 'burial_benefit'
  if (/年金|未支給年金|年金事務所/u.test(value)) return 'pension'
  if (/相続放棄|限定承認|熟慮期間/u.test(value)) return 'inheritance_renunciation'
  if (/準確定申告/u.test(value)) return 'final_income_tax'
  if (/相続税/u.test(value)) return 'inheritance_tax'
  if (/相続登記|不動産.{0,12}(?:相続|名義変更)|名義変更.{0,12}不動産/u.test(value)) return 'real_estate_registration'
  if (/死亡届|死体検案書|死亡診断書/u.test(value)) return 'death_notification'
  if (/銀行|口座|携帯|電話|クレジット|カード|ローン|電気|ガス|水道|契約|解約|葬儀|火葬|納骨|墓地|遺品|形見|生命保険|死亡保険金|介護保険/u.test(value)) return 'aftercare_general'
  if (/優先|今すぐ|最初|何から|何を.{0,8}(?:すれ|やれ)|順番|急ぐ|期限が近/u.test(value)) return 'priority_overview'
  return 'aftercare_general'
}

export function directReplyForIntent(intent: ChatIntent): string | null {
  if (intent === 'out_of_scope') {
    return 'この相談は、死亡後の手続きに関する質問に対応しています。死亡届、健康保険、年金、相続、税金、不動産の名義変更などについて質問してください。'
  }
  if (intent === 'delegated_action') {
    return '役所や金融機関などへの提出・申請を代行することはできません。提出期限、提出先、必要書類、手順は案内できます。進めたい手続きの名称を教えてください。'
  }
  return null
}
