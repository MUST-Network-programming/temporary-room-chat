# 同行 · 前端 UI 改版

本次仅修改 `web/index.html`、`web/style.css`、`web/app.js`，新增这份说明、DOM 集成测试和参考项目许可证。C 服务端、Socket / TLS / WebSocket 协议、账号与房间逻辑保持不变。未推送、未部署。

## 设计参考与实现

实际拉取并阅读了 https://github.com/jakobhoeg/shadcn-chat ，参考版本 `47e5f8af020b6eacbd4cbd6ad5f6ff8d60e76aa8`。
重点参考 `apps/www/src/components/sidebar.tsx`、`chat/chat-layout.tsx`、`chat/chat-list.tsx`、`chat/chat-bottombar.tsx` 和 `packages/ui/src/components/ui/chat/chat-bubble.tsx`。

借鉴中性配色、分栏聊天空间、当前房间高亮、头像与左右气泡、底部紧凑输入框。使用原有原生 HTML/CSS/JavaScript 实现，没有引入 React、Tailwind 或运行时依赖。未复制参考项目的演示会话、假回复及未实现的附件、语音、搜索消息按钮。参考项目的 MIT 许可保留在 `vendor/shadcn-chat-LICENSE`。

- 桌面：房间导航 / 最近房间、聊天面板、在线成员与房间信息三栏。
- 大厅：加入房间与创建房间分卡展示，明确持码入房与到期清空的规则。
- 最近房间：真实本机记录，支持名称 / 加入码搜索；点击填入加入码，不会绕过服务端校验。仍在房间时提示先离开，以免意外关闭房主房间。
- 聊天：用户首字头像、自己的消息靠右、服务端回放、贴图与表情、滚动跟随和回到最新。
- 完整保留账号登录 / 邀请注册、创建 / 加入 / 离开、房主改名 / 关闭、到期、心跳与重连恢复。
- 浅色 / 深色 / 跟随系统，选择保存在本机；窄屏房间信息通过按钮展开，手机大厅单列。
- 保留 IME 输入保护、Enter 发送 / Shift + Enter 换行、UTF-8 字节上限、消息纯文本输出、无障碍标签与减少动态效果偏好。
- 修正原更改群名取消弹窗后不应显示空群名错误的小问题。
- 消息在有对话后隐藏欢迎空状态，并按一条线程上下堆叠（对方居左、自己居右），不再把气泡拉开。
- 更改群名改为页内表单，避免系统弹窗阻塞导致心跳中断。

## 本地运行

保持原构建与运行方法（详见根目录 README）。Linux 构建依赖示例：

```sh
sudo apt-get install cmake gcc make libssl-dev libsqlite3-dev
cmake -S . -B build
cmake --build build -j4
./build/chat_server --anonymous-loopback --port 8080
```

访问 http://127.0.0.1:8080 。匿名模式仅限本机演示，不加密；跨设备仍应使用原有 HTTPS/WSS 账号模式。无需 npm install 即可运行网页。

## 已执行的测试

- `node --check web/app.js`。
- CMake 构建与 CTest：4/4 通过（WebSocket、房间、HTTP、transport）。
- `python3 tests/integration.py`：通过房间隔离、碎片帧、重连、授权、边界、最新 100 条顺序回放等。
- `python3 tests/expiry_load.py`：通过到期关闭 / 拒绝迟到加入；20 客户端、40 次广播、800 次精确投递。
- 生成本机演示证书后，`python3 tests/accounts.py`：通过 WSS 账号门禁、单次注册码、回滚、身份接管、令牌恢复、重启持久化。
- 同样以 TLS 证书参数运行 integration 和 expiry_load：通过；不可信 CA 与主机名不匹配均被拒绝。
- HTML 唯一 ID、ARIA / label 与 JavaScript 引用、实际 HTTP 内容及 MIME 检查通过。
- `tests/ui-smoke.cjs`：两份 DOM 前端实例连接真实 C WebSocket 服务，验证大厅、创建、改名、加入、在线成员、消息广播、纯文本防注入、贴图、断线后身份与记录恢复、主题、房间信息、离开、最近房间搜索和关闭，无脚本运行错误。

DOM 测试不是浏览器视觉验收。它需要 Node.js、外置 jsdom / ws，以及已运行的 8080 匿名服务；不属于网页运行依赖：

```sh
npm install --prefix /tmp/chat-ui-test-tools jsdom ws
NODE_PATH=/tmp/chat-ui-test-tools/node_modules node tests/ui-smoke.cjs
```

浏览器视觉检查、移动端布局与真实录屏由交付前的桌面验收完成，不能以这些 DOM 测试替代。

## 交付安全

交付源码不包含 build、账号数据库、证书及私钥、依赖安装目录、测试日志。解压后重新构建；如要使用 TLS，请在演示机器上自行重新生成证书。服务端内存房间与聊天不随源码分发。
