# 英文和訳トレーナー

GitHubのブラウザからアップロードしやすいよう、必要ファイルを同じ階層にまとめた公開用版です。

## 必要な環境変数
- DATABASE_URL
- SESSION_SECRET
- INIT_TEACHER_PASSWORD
- OPENAI_API_KEY
- OPENAI_MODEL（任意。既定値: gpt-5.6-luna）

## 公開後
- 生徒画面: `/`
- 教師画面: `/teacher`
- ヘルスチェック: `/api/health`

※秘密情報（APIキーやパスワード）はGitHubに保存しないでください。
