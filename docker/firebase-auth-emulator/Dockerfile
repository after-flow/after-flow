# ローカル開発専用の Firebase Auth Emulator。
#
# firebase-tools（npm）に含まれる Auth Emulator を使う。gcloud emulators
# イメージには含まれておらず、Java も不要。メジャーを固定してビルドの
# 再現性を保つ（マイナー・パッチの自動追従はしない）。
FROM node:22.23.2-bookworm-slim@sha256:48e4b67d85f87bd551df43704e24d252f56cc5f8e9718841aace50f19948f0f9

WORKDIR /emulator
RUN npm install --global firebase-tools@13 --loglevel=error

COPY firebase.json ./firebase.json

EXPOSE 9099
