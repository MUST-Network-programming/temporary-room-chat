#include "chat.h"
#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#ifndef WEB_ROOT
#define WEB_ROOT "第4位"
#endif
#define HEADER_LIMIT 8192
#ifdef _WIN32
#include <windows.h>
#endif

static void http_error(Client *c, int code, const char *reason) {
    char response[512];
    int n = snprintf(response, sizeof(response),
        "HTTP/1.1 %d %s\r\nContent-Type: text/plain; charset=utf-8\r\n"
        "Content-Length: %zu\r\nConnection: close\r\nX-Content-Type-Options: nosniff\r\n\r\n%s",
        code, reason, strlen(reason), reason);
    if (n > 0 && (size_t)n < sizeof(response)) queue_bytes(c, response, (size_t)n);
    c->closing = 1;
}

void http_process(Client *c) {
    size_t header_len = 0;
    char request[HEADER_LIMIT + 1], method[16], path[512], version[16];
    const char *filename = NULL, *content_type = NULL;
    char asset_path[4096], response[1024];
    FILE *file;
    long file_len;
    unsigned char *body;
    int n;
    if (c->closing || c->dead) return;
    /* HTTP 头可能跨多个 recv；只在完整 CRLFCRLF 出现后解析。 */
    for (size_t i = 0; i + 3 < c->input_len; i++) {
        if (memcmp(c->input + i, "\r\n\r\n", 4) == 0) { header_len = i + 4; break; }
    }
    if (!header_len) {
        if (c->input_len >= HEADER_LIMIT) http_error(c, 431, "Request Header Fields Too Large");
        return;
    }
    if (header_len > HEADER_LIMIT) { http_error(c, 431, "Request Header Fields Too Large"); return; }
    if (memchr(c->input, '\0', header_len)) { http_error(c, 400, "Bad Request"); return; }
    memcpy(request, c->input, header_len); request[header_len] = '\0';
    if (sscanf(request, "%15s %511s %15s", method, path, version) != 3 || strcmp(version, "HTTP/1.1") != 0) {
        http_error(c, 400, "Bad Request"); return;
    }
    if (strcmp(method, "GET") != 0) { http_error(c, 405, "Method Not Allowed"); return; }
    if (strcmp(path, "/ws") == 0) {
        /* 先握手，再消费头；同一次 recv 后附带的首个帧必须保留。 */
        if (!ws_handshake(c, request)) { if (!c->closing) http_error(c, 400, "Bad WebSocket Request"); return; }
        memmove(c->input, c->input + header_len, c->input_len - header_len);
        c->input_len -= header_len;
        if (c->input_len) ws_process(c);
        return;
    }
    /* 固定白名单不把 URL 拼成任意文件路径，阻止目录穿越。 */
    if (!strcmp(path, "/") || !strcmp(path, "/index.html")) { filename = "index.html"; content_type = "text/html; charset=utf-8"; }
    else if (!strcmp(path, "/style.css")) { filename = "style.css"; content_type = "text/css; charset=utf-8"; }
    else if (!strcmp(path, "/app.js")) { filename = "app.js"; content_type = "text/javascript; charset=utf-8"; }
    else { http_error(c, 404, "Not Found"); return; }
    n = snprintf(asset_path, sizeof(asset_path), "%s/%s", WEB_ROOT, filename);
    if (n < 0 || (size_t)n >= sizeof(asset_path)) { http_error(c, 500, "Internal Server Error"); return; }
    #ifdef _WIN32
    /* Windows 文件系统使用 UTF-16，不能把中文 UTF-8 路径直接交给 ANSI fopen。 */
    wchar_t wide_path[4096];
    if (!MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, asset_path, -1, wide_path, 4096)) {
        http_error(c, 500, "Internal Server Error"); return;
    }
    file = _wfopen(wide_path, L"rb");
#else
    file = fopen(asset_path, "rb");
#endif
    if (!file) { http_error(c, 404, "Not Found"); return; }
    if (fseek(file, 0, SEEK_END) || (file_len = ftell(file)) < 0 || file_len > OUTPUT_CAP - 2048 || fseek(file, 0, SEEK_SET)) {
        fclose(file); http_error(c, 500, "Internal Server Error"); return;
    }
    body = malloc((size_t)file_len + 1);
    if (!body) { fclose(file); http_error(c, 500, "Internal Server Error"); return; }
    if (fread(body, 1, (size_t)file_len, file) != (size_t)file_len) {
        free(body); fclose(file); http_error(c, 500, "Internal Server Error"); return;
    }
    fclose(file);
    n = snprintf(response, sizeof(response),
        "HTTP/1.1 200 OK\r\nContent-Type: %s\r\nContent-Length: %ld\r\nConnection: close\r\n"
        "Cache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\n"
        "Content-Security-Policy: default-src 'self'; connect-src 'self' ws: wss:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'\r\n\r\n",
        content_type, file_len);
    queue_bytes(c, response, (size_t)n); queue_bytes(c, body, (size_t)file_len);
    free(body);
    /* closing 表示停止读取，连接层须先排空输出队列再真正关闭 socket。 */
    c->closing = 1;
}
