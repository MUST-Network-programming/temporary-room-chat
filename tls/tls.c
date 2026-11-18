#include "chat.h"
#include "platform.h"
#include <openssl/err.h>
static SSL_CTX *context;
/* 返回 -2 表示等待 readiness，-1 表示连接应关闭。 */
static int tls_result(Client *c, int result, int *want) {
    int error=SSL_get_error(c->ssl,result);
    if (error==SSL_ERROR_WANT_READ) { *want=1; return -2; }
    if (error==SSL_ERROR_WANT_WRITE) { *want=2; return -2; }
    *want=0;
    return -1;
}
int tls_init(const char *cert, const char *key) {
    context=SSL_CTX_new(TLS_server_method());
    if (!context) return 0;
    SSL_CTX_set_min_proto_version(context,TLS1_2_VERSION);
    SSL_CTX_set_options(context,SSL_OP_NO_COMPRESSION);
    if (SSL_CTX_use_certificate_chain_file(context,cert)!=1 ||
        SSL_CTX_use_PrivateKey_file(context,key,SSL_FILETYPE_PEM)!=1 ||
        SSL_CTX_check_private_key(context)!=1) {
        ERR_print_errors_fp(stderr); tls_cleanup(); return 0;
    }
    return 1;
}
int tls_attach(Client *c) {
    c->ssl=SSL_new(context);
    if (!c->ssl) return 0;
    if (SSL_set_fd(c->ssl,(int)c->fd)!=1) return 0;
    SSL_set_accept_state(c->ssl);
    c->tls_want=1;
    return 1;
}
int tls_handshake(Client *c) {
    ERR_clear_error();
    int result=SSL_accept(c->ssl);
    if (result==1) { c->tls_ready=1; c->tls_want=0; return 1; }
    return tls_result(c,result,&c->tls_want);
}
int transport_read(Client *c, void *buffer, int capacity) {
    if (!c->ssl) {
        int result=(int)recv(c->fd,(char*)buffer,capacity,0);
        return result<0 ? (would_block() ? -2 : -1) : result;
    }
    ERR_clear_error();
    int result=SSL_read(c->ssl,buffer,capacity);
    if (result>0) { c->read_want=0; return result; }
    return tls_result(c,result,&c->read_want);
}
int transport_write(Client *c, const void *buffer, int length) {
    if (!c->ssl) {
        int result=(int)send(c->fd,(const char*)buffer,length,0);
        return result<0 ? (would_block() ? -2 : -1) : result;
    }
    ERR_clear_error();
    int result=SSL_write(c->ssl,buffer,length);
    if (result>0) { c->write_want=0; return result; }
    return tls_result(c,result,&c->write_want);
}
void tls_close(Client *c) {
    if (c->ssl) {
        /* 非阻塞 best-effort close_notify，不能让一个退出者拖住事件循环。 */
        if (c->tls_ready && !c->dead) SSL_shutdown(c->ssl);
        SSL_free(c->ssl); c->ssl=NULL;
    }
}
void tls_cleanup(void) { SSL_CTX_free(context); context=NULL; }
