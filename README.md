# QQ-Companion

自托管的 QQ AI 伙伴。支持主动聊天的本地心跳、Qwen 音色配置，以及通过 Music 3 接口在后台生成歌曲。

## 启动

需要 Node.js 24.13+。启动前将 .env.example 复制为 .env，并填写 QQ_ADMIN_PASSWORD。

    npm ci
    npm run build
    npm start

打开管理页 http://127.0.0.1:3210/qq-companion/。接入 QQ 时配置伙伴账号、授权会话、模型密钥和外部网关地址。网关连接使用 HTTP API 和正向 WebSocket。[OneBot 11 官方 GitHub 仓库](https://github.com/botuniverse/onebot-11)

## 许可证

[MIT](LICENSE)
