> **本地 v2 预览：** [UI / 行程邮件 / 启动与录屏步骤](docs/本地预览-v2.md)。仅修改用户提供的本地源码，未同步或部署线上。

---
tags: [网络编程, C语言, 课程项目]
---
# 临时房间安全聊天系统

C11 服务端使用 Socket、select、非阻塞 IO；浏览器通过 WebSocket 通信。基础版 HTTP/WS 与 TLS 版 HTTPS/WSS 使用同一套房间逻辑。五个目录与汇报顺序对应，模块内附说明和演示。

## macOS 构建与运行

在终端进入本项目目录。安装 Xcode Command Line Tools（已有则跳过）与依赖。

```sh
xcode-select --install
brew install cmake openssl@3
cmake -S . -B build -DOPENSSL_ROOT_DIR="$(brew --prefix openssl@3)"
cmake --build build
./build/chat_server --anonymous-loopback --port 8080
```

浏览器打开 http://localhost:8080 。打开两个窗口，创建房间后复制房间码到另一个窗口加入。按 Ctrl+C 停止服务器。

```sh
python3 tls/make_certs.py
./build/chat_server --port 8443 --cert tls/certs/server.crt --key tls/certs/server.key
```

先按 [[tls/模块说明与演示]] 配置信任，再打开 https://localhost:8443 。证书生成脚本拒绝覆盖已有 CA。项目内已生成的证书用于当前本机测试，分发源码时排除 certs 文件夹并在演示机器重新生成。

## Windows 原生构建

安装 Visual Studio 2022 Build Tools，勾选“使用 C++ 的桌面开发”（包含 MSVC、Windows SDK 和 CMake）。安装 Git 与 Python 3。打开 **Developer PowerShell for VS 2022**。以下命令使用 Windows 原生 MSVC 和 Winsock。

```powershell
cd C:\
git clone https://github.com/microsoft/vcpkg.git C:\vcpkg
C:\vcpkg\bootstrap-vcpkg.bat
C:\vcpkg\vcpkg.exe install openssl:x64-windows sqlite3:x64-windows
cd '项目所在路径\临时房间安全聊天系统'
cmake -S . -B build-win -G 'Visual Studio 17 2022' -A x64 -DCMAKE_TOOLCHAIN_FILE=C:/vcpkg/scripts/buildsystems/vcpkg.cmake -DVCPKG_TARGET_TRIPLET=x64-windows
cmake --build build-win --config Release
$env:PATH = 'C:\vcpkg\installed\x64-windows\bin;C:\vcpkg\installed\x64-windows\tools\openssl;' + $env:PATH
.\build-win\Release\chat_server.exe --anonymous-loopback --port 8080
```

打开 http://localhost:8080 。TLS 模式先在同一终端执行 `python tls/make_certs.py`，然后带 `--cert` 和 `--key` 参数启动。上述步骤已按原生工具链准备，当前 Windows 运行和浏览器互测待组员实测。

## 局域网两台电脑互测

两台机器连接同一网络。正式跨设备联调使用 HTTPS 账号模式。按下面「账号注册与发码」启动服务，另一台通过 `https://服务端局域网IP:8443` 登录。Windows 若提示防火墙访问，允许当前私人网络的入站连接。交换服务端与客户端角色，再重复测试。HTTP 匿名模式用于本机协议演示。

TLS 跨机器演示须在生成证书时加入实际服务端 IP，例如 `python3 tls/make_certs.py --ip 192.168.1.20`。在两端信任同一个演示 CA 后访问 `https://192.168.1.20:8443`。CA 私钥与服务端私钥只留在服务端。

## 自动验收

```sh
python3 tests/integration.py
python3 tests/integration.py build/chat_server tls/certs
ctest --test-dir build --output-on-failure
python3 tests/expiry_load.py
python3 tests/expiry_load.py build/chat_server tls/certs
```

Windows 可执行 `python tests/integration.py build-win/Release/chat_server.exe`，TLS 测试末尾添加 `tls/certs`。

[[docs/验收记录]] 记录实际运行结果，[[docs/协议与答辩]] 说明协议和总体设计。每位成员的模块说明包含三分钟演示流程。

## 运行约束

服务端默认只监听本机，最多 64 个连接、16 个房间，房间默认 3600 秒到期，可用 `--ttl 10` 演示过期（范围 1～86400 秒）。正文最多 2048 UTF-8 字节。内存存储随进程退出清空。每个房间保留最近 100 条聊天和贴图，加入或重连会回放，关房或到期即清除。房主可改群名，房间码继续有效。浏览器会按网址保存最近 5 个房间码与群名，切换 HTTP/HTTPS 或地址后使用各自的列表。TLS 保护浏览器到服务器之间的通信，服务端能读取聊天正文。加入码允许持有者入房，房主身份由随机会话令牌验证。

浏览器会话令牌保存在当前标签页的 sessionStorage。网络断开后自动尝试重连，服务器保留可恢复身份到房间过期。显式离开撤销该身份，房主显式离开或关闭会结束房间。

第三方 cJSON 1.7.19 随源码分发，许可见 vendor/cJSON-LICENSE。OpenSSL 通过系统依赖链接。

## 服务端终端日志

启动时加 `--log-chat`，服务端终端会显示建房、入房、恢复连接、离房、断线、改名、关房以及聊天正文和贴图编号。每行包含时间戳和房间码，适用的事件会带昵称。默认关闭。日志通过标准错误输出，可由拥有该终端或日志访问权限的人员查看。答辩使用测试消息。

```sh
./build/chat_server --bind 172.20.10.5 --port 8443 --cert tls/certs/server.crt --key tls/certs/server.key --log-chat
```

将绑定地址替换为实际网卡 IP，使用匹配该地址的证书。

## 账号注册与发码

组织者在项目根目录执行以下命令一次，得到一个随机注册码。每位参与者单独领一个。每次生成新的注册码都再执行一次。

```sh
./build/chat_server --accounts accounts.sqlite3 --issue-invite
```

启动时使用同一数据库和匹配地址的证书。下面使用热点 IP，请按现场网卡地址调整。

```sh
./build/chat_server --bind 172.20.10.5 --port 8444 --accounts accounts.sqlite3 --cert tls/certs/server.crt --key tls/certs/server.key
```

浏览器信任项目 CA 后打开服务地址，选择「注册账号」，输入 3–24 位小写字母、数字或下划线组成的用户名和至少 8 个字节的密码，粘贴注册码后提交。注册成功即登录，之后用账号密码登录。用户名同时作为房间昵称。同一账号重入同一个房间时接管旧连接并保留房主角色。

SQLite 持久保存账号和注册码使用状态。密码只保存带随机盐的 PBKDF2-SHA256 校验值。登录令牌和房间在服务重启后失效，账号仍可重新登录。服务端账号模块使用 SQLite，macOS 可用系统 SDK 提供的 SQLite，Windows 通过 vcpkg 安装。账号数据库和证书私钥由组织者保管，分发源码时不包含这些文件。

在 macOS 运行 `python3 tests/accounts.py` 可复验注册码、持久化和身份恢复。
