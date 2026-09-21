# Skill output contracts

6つのSkillに、実際のWorkflow・委任・Context構築で使うZod Schemaから生成した `references/output-schema.json` を添付する。Mastraの標準Skill参照として読み込み、Schemaと処理境界もSkillの版/hashに含める。Skill版は1.1.0。

case-assessmentはハーネスが構築したContext、research-briefingは委任先Briefの選択、調査・根拠照合はResearchFindings、案内は現在のChat/Guidance、変更提案は現在の計画/抽出Draftとハーネスが組み立てたProposalの契約を使用する。複数Schemaを含むSkillでも、現在のWorkflowが要求した出力だけを返す。

JSON Schemaは型の説明であり、Zodの追加制約、出典の所属、Contextの版、Tool権限、Backendの承認を代替しない。独立したSkill実行ループや新しいAgentを追加せず、既存の実行境界で検証する。
