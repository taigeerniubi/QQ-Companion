# QQ-Companion

自托管的 QQ AI 伙伴。支持 QQ 私聊和群聊、DeepSeek 对话、Qwen 语音和本地 SQLite 记忆。

## 启动

需要 Node.js 24.13+。启动时生成的管理口令保存在本地 data/admin-token。也可在 .env.local 配置 QQ_ADMIN_TOKEN。

    npm install
    npm run build
    npm start

打开管理页 http://127.0.0.1:3210/qq-companion/。接入 QQ 时配置伙伴账号、授权会话、模型密钥和外部网关地址。网关连接使用 HTTP API 和正向 WebSocket。[OneBot 11 官方 GitHub 仓库](https://github.com/botuniverse/onebot-11)

## 许可证

[MIT](LICENSE)
