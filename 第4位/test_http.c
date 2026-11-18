/* 独立测试使用桩函数，隔离 HTTP 模块；运行方式见本目录 README。 */
#include "chat.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>
static int handshake_calls, frame_calls;
void queue_bytes(Client *c, const void *data, size_t len) {
    assert(c->output_len + len < OUTPUT_CAP);
    memcpy(c->output + c->output_len, data, len); c->output_len += len;
}
int ws_handshake(Client *c, const char *request) {
    assert(strstr(request, "GET /ws HTTP/1.1\r\n"));
    assert(c->input_len > 0); handshake_calls++; c->websocket = 1; return 1;
}
void ws_process(Client *c) { assert(c->input_len == 3); assert(!memcmp(c->input, "XYZ", 3)); frame_calls++; }
static Client client;
static void input(const char *s) { memset(&client, 0, sizeof(client)); memcpy(client.input, s, strlen(s)); client.input_len = strlen(s); }
int main(void) {
    input("GET / HTTP/1.1\r\nHost: localhost\r\n"); http_process(&client);
    assert(!client.closing && !client.output_len);
    memcpy(client.input + client.input_len, "\r\n", 2); client.input_len += 2; http_process(&client);
    assert(client.closing && strstr((char *)client.output, "200 OK") && strstr((char *)client.output, "<!doctype html>"));
    input("GET /../include/chat.h HTTP/1.1\r\n\r\n"); http_process(&client); assert(strstr((char *)client.output, "404 Not Found"));
    input("POST / HTTP/1.1\r\n\r\n"); http_process(&client); assert(strstr((char *)client.output, "405 Method Not Allowed"));
    input("GET /ws HTTP/1.1\r\nHost: localhost\r\n\r\nXYZ"); http_process(&client); assert(handshake_calls == 1 && frame_calls == 1);
    memset(&client, 0, sizeof(client)); memset(client.input, 'A', 8192); client.input_len = 8192; http_process(&client);
    assert(strstr((char *)client.output, "431 Request Header Fields Too Large"));
    input("GET / HTTP/1.1\r\nX: hello\r\n\r\n"); client.input[20] = 0; http_process(&client); assert(strstr((char *)client.output, "400 Bad Request"));
    puts("HTTP tests: 6 passed"); return 0;
}
