# rooms：房间与成员管理

本模块实现 `room_message`、`room_disconnect`、`room_tick`，由单线程事件循环调用，不需要线程锁。源代码为 `rooms.c`，单元测试为 `test_rooms.c`。

## 数据与身份

- 最多 16 个房间，每房间最多 64 个成员会话，全局最多 256 个会话。离线会话仍占名额，房间到期全部回收。
- 房间码由 OpenSSL `RAND_bytes` 产生，使用 32 个易辨识字符随机生成 6 位码，并检查现有房间碰撞。房间码是加入入口，不是私密身份凭据。
- 每个成员拥有 32 字节安全随机令牌，编码为 64 位十六进制字符串。房主身份属于会话，不属于昵称。
- `room_ttl` 由主程序设置，默认方案为 3600 秒。房间创建时固定到期时间，聊天与重连不会续期。
- `Client.member` 初始值必须是 `-1`。断开只解除连接绑定；成员主动离开撤销令牌；房主主动离开关闭整个房间。
- 在线列表只含当前绑定连接的昵称。同令牌恢复会替换旧连接，旧连接随后发生重复断开也不会清除新连接的身份。

## 数据验证与模块边界

业务层独立验证 JSON 对象、重复字段、字段类型、未知字段、尾随垃圾、UTF-8 字符串及字节上限。昵称为 1–48 个 UTF-8 字节，正文为 1–2048 个 UTF-8 字节。昵称禁止控制字符；正文允许换行、回车与制表符。`\u0000` 在解析前拒绝，防止 cJSON 的 C 字符串截断隐藏字段内容。反斜杠转义后的普通文本 `\\u0000` 可以正常发送。

所有广播仅遍历同一房间当前在线成员。每个接收者取得单独的 JSON 副本；`send_json` 负责释放它。发送队列和慢客户端断开由server负责。

## 消息示例

```json
{"type":"create","nickname":"小陶"}
{"type":"join","room":"ABC234","nickname":"同学"}
{"type":"join","room":"ABC234","nickname":"小陶","token":"服务器之前返回的64位令牌"}
{"type":"chat","text":"集合地点在入口"}
{"type":"leave"}
{"type":"close"}
{"type":"ping"}
```

创建、加入和恢复成功依次发送 `joined` 和在线 `members`。`joined` 包含 `room`、`nickname`、`token`、布尔值 `owner` 和 epoch 秒数 `expires`。关闭原因包括 `owner_closed`、`owner_left`、`expired`；普通成员主动离开仅向自己发送 `closed`，原因为 `left`，其余人收到更新后的成员列表。无效令牌不会降级为匿名加入。

## 独立测试

macOS 已执行（2026-11-04，系统 clang、Homebrew OpenSSL 3）：

```sh
cd '/Users/taoweihao/Downloads/临时房间安全聊天系统'
cmake --build build
ctest --test-dir build -R test_rooms --output-on-failure
```

结果：`PASS: isolation / ownership / reconnect / replacement / validation / leave / expiry / capacity`。

测试用发送桩捕获 JSON，实际验证了双房间隔离、非房主关闭拒绝、昵称占用、非法令牌、房主恢复、在线连接替换及旧连接重复断开、NUL/重复字段/类型/尾随字符/非法 UTF-8 拒绝、普通成员离开后令牌失效、房主离开、超时回收及 16 房间容量。此测试证明业务层行为；真实 socket、TLS、浏览器以及 Windows 联调以总项目测试记录为准。

Windows 在项目根目录、安装 OpenSSL 开发库后，可用 Visual Studio x64 Native Tools 运行（本机未实测）：

```bat
cmake --build build-win --config Release
ctest --test-dir build-win -C Release -R test_rooms --output-on-failure
```

OpenSSL 不同发行版的库目录可能不同，请按实际安装位置修改 `/LIBPATH`，并将其 `bin` 放入 PATH。

## 约 3 分钟演示

1. 用两个浏览器窗口创建房间 A、B，再开一个窗口加入 A。A 中发送消息，观察 B 没收到。说明广播依据会话保存的 room 索引，不接受用户伪造目标昵称。
2. 让 A 的普通成员尝试关闭，观察 `forbidden`；使用房主关闭，观察成员全部退出，再使用原码加入会失败。
3. 新建房间，让房主短暂掉线，恢复后说明令牌恢复 owner；另一人仅复制昵称无法接管。
4. 使用短房间时长启动服务端，等待关闭提示，说明 `room_tick` 周期回收与每条消息前的到期检查。

答辩重点：房间保存共享生命周期，成员会话保存身份与权限，TCP 连接仅代表当前在线传输通道。这三个概念分开，才能正确处理断线重连。
