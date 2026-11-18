#ifndef CHAT_H
#define CHAT_H
#include <stddef.h>
#include <stdint.h>
#include <time.h>
#include <openssl/ssl.h>
#include "cJSON.h"
#ifdef _WIN32
#include <winsock2.h>
typedef SOCKET socket_t;
#else
typedef int socket_t;
#endif
#define MAX_CLIENTS 64
#define INPUT_CAP 32768
#define OUTPUT_CAP (512 * 1024)
#define MESSAGE_CAP 8192
typedef struct Client {
    socket_t fd;
    int active, websocket, closing, dead;
    SSL *ssl;
    int tls_ready, tls_want, read_want, write_want;
    unsigned char input[INPUT_CAP], output[OUTPUT_CAP], message[MESSAGE_CAP];
    size_t input_len, output_len, output_sent, message_len;
    int fragmented;
    time_t last_seen, accepted;
    int member;
    char account[25], login_token[65];
    time_t next_auth_attempt;
} Client;
extern Client clients[MAX_CLIENTS];
extern unsigned room_ttl;
extern int log_chat;
void queue_bytes(Client *c, const void *data, size_t len);
void ws_send(Client *c, int opcode, const void *data, size_t len);
void send_json(Client *c, cJSON *json); /* 发送后释放 json */
void send_error(Client *c, const char *code, const char *message);
int ws_handshake(Client *c, const char *request);
void ws_process(Client *c);
void room_message(Client *c, const char *text, size_t len);
void room_disconnect(Client *c);
void room_tick(time_t now);
void http_process(Client *c);
int tls_init(const char *cert, const char *key);
int tls_attach(Client *c);
int tls_handshake(Client *c);
int transport_read(Client *c, void *buffer, int capacity);
int transport_write(Client *c, const void *buffer, int length);
void tls_close(Client *c);
void tls_cleanup(void);
#endif
