# 第4位：浏览器、静态 HTTP 与连接恢复

## 文件与职责

- `http.c`：接收完整 HTTP 头，提供固定的三个前端资源，转交 `/ws` 升级握手。
- `index.html`、`style.css`、`app.js`：无需 npm、CDN 或外部字体的中文响应式聊天界面。
- `test_http.c`：HTTP 模块独立回归；桩函数代替 WebSocket 与输出队列。

页面采用明亮纸色和深绿主色，桌面为在线成员与聊天双栏，手机纵向排列。设计假设：旅游或活动现场使用，先保证房间码、连接状态和发送操作清楚。

## 启动

在项目根目录执行总 README 的 CMake 构建与启动命令，浏览器打开服务器打印的 HTTP 或 HTTPS 地址。不要直接双击 HTML 文件，WebSocket 需要与服务器同源。

CMake 把源码目录下的 `第4位` 绝对路径编译为 `WEB_ROOT`，所以可从任意工作目录启动。移动项目后应重新运行 CMake 并构建；仅复制二进制不能携带网页。手工编译不指定宏时，默认从当前工作目录的 `第4位` 读取资源，因此要在项目根目录启动。静态文件每次请求重新读取，修改后刷新即可。

## 消息与状态

浏览器发送 `create {nickname}`、`join {room,nickname,token?}`、`chat {text}`、`leave`、`close`、`ping`，每条都有 `type`。接收 `joined`、`members`、`chat`、`closed`、`error`、`pong`。

`joined` 返回的 token、room、nickname 存在当前标签页的 sessionStorage。断线重连先完成 WebSocket，再发送带 token 的 join。刷新也尝试恢复；存储受限时当前页面仍可使用。房间关闭或主动离开会移除会话，禁止自动重新入房。恢复失败同样清空失效会话，并要求手动选择房间。

每 15 秒发送一次应用层 ping；若上次有效 JSON 消息距今超过 45 秒，在下次心跳检查时关闭连接，因此实际检测可能略超过 45 秒。连接断开按约 1、2、4、8、15 秒退避，每次增加 ±20% 随机抖动，总延迟上限 15 秒。连接恢复后恢复身份，服务端回放房间最近 100 条文字和贴图。

发送禁用期间保留草稿。所有昵称、正文、错误提示通过 textContent 插入，聊天消息不会当作 HTML 执行。昵称按 UTF-8 48 字节检查；正文 2048 字节。浏览器最多显示 500 个消息节点，避免无限增长。客户端限制是体验优化，服务器仍需独立校验。

## HTTP 原理

TCP 的一次读取不等于完整请求。`http_process` 在输入缓冲里寻找 CRLFCRLF，不完整就等待下一次调用，头部超过 8 KiB 返回 431。只允许 GET 与 HTTP/1.1，只开放 `/`、`/index.html`、`/style.css`、`/app.js`，任意其他路径返回 404，目录穿越无法映射到磁盘文件。

`/ws` 先调用 `ws_handshake`，再移走 HTTP 头，保留本次读取已经收到的 WebSocket 字节交给 `ws_process`。静态响应调用 queue_bytes 后标记 closing，连接层要排空输出再关闭，不能立刻丢弃响应。

这是课程最小 HTTP 实现，不是通用文件服务器，不支持 Keep-Alive、范围请求、缓存协商、HEAD 或 URL 查询参数。

## 已执行的模块验证

2026-11-04，macOS 本机执行：

```sh
node --check 第4位/app.js
cc -std=c11 -Wall -Wextra -Wpedantic -fsyntax-only \
  -Iinclude -Ivendor -I/opt/homebrew/opt/openssl@3/include 第4位/http.c
cc -std=c11 -Wall -Wextra -Wpedantic \
  -Iinclude -Ivendor -I/opt/homebrew/opt/openssl@3/include \
  第4位/http.c 第4位/test_http.c -o /tmp/chat_test_http
/tmp/chat_test_http
```

结果：JavaScript 语法检查通过，C 语法检查无警告，HTTP 独立回归 `6 passed`，覆盖分段请求、静态页面、目录穿越、错误方法、握手附带首帧、超长头与 NUL 拒绝（部分情形合在同一组）。实际浏览器及集成测试以总测试报告为准；Windows 原生运行待组员实测。

界面机械检测执行过一次，但工具缺少 HTML/CSS 解析依赖，只进行了降级正则检查；无命中不代表可访问性或视觉完整验收。

## 三分钟演示

1. 打开两个浏览器窗口，各填不同昵称。窗口 A 创建房间，把 6 位码复制到 B 加入，展示在线列表与互发消息。
2. 在开发者工具 Network 切换 Offline，等待心跳超时（最多约 60 秒）；输入草稿但不能发送。恢复 Online，展示自动恢复原房间和昵称，再发送草稿。也可在控制台调用 `socket.close()` 主动制造断开，较快观察重连；这是测试手段，不等同于实际网络故障。
3. 房主关闭房间，两个窗口均回到入房界面。刷新后不会重新加入已经关闭的房间。
4. 讲解为何连接成功还要重新 join，以及 token 和昵称的区别。刷新后验证最近消息按原顺序回放。
