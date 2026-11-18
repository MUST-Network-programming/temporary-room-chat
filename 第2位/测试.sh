#!/bin/sh
# 从任意目录执行；需要 C 编译器、pkg-config、OpenSSL 开发包。
set -eu
cd "$(dirname "$0")/.."
test_binary=$(mktemp /tmp/chat_ws_test.XXXXXX)
trap 'rm -f "$test_binary"' EXIT HUP INT TERM
cc -std=c11 -Wall -Wextra -Wpedantic ${WS_TEST_CFLAGS:-} \
  -Iinclude -Ivendor $(pkg-config --cflags openssl) \
  第2位/test_websocket.c 第2位/websocket.c vendor/cJSON.c \
  $(pkg-config --libs openssl) -o "$test_binary"
"$test_binary"
