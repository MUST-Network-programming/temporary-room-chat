#include "chat.h"
#include "accounts.h"
#include "platform.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <signal.h>
#include <limits.h>
#ifndef _WIN32
#include <sys/stat.h>
#endif
Client clients[MAX_CLIENTS];
unsigned room_ttl=3600;
static volatile sig_atomic_t stopping;
static size_t pending_write[MAX_CLIENTS];
static unsigned char read_buffer[MAX_CLIENTS][16384];
static void stop_server(int signal_number) { (void)signal_number; stopping=1; }
/* 未发完的字节保持原地址，TLS WANT 后重试还必须保持原长度。 */
void queue_bytes(Client *c, const void *data, size_t len) {
    if (c->dead) return;
    if (len>OUTPUT_CAP-c->output_len) { c->dead=1; return; }
    memcpy(c->output+c->output_len,data,len); c->output_len+=len;
}
static void disconnect_client(Client *c) {
    room_disconnect(c);
    tls_close(c);
    close_socket(c->fd);
    c->active=0;
}
static int ready(int want, int readable, int writable) {
    return want==2 ? writable : readable;
}
static void accept_client(socket_t listener, int use_tls) {
    socket_t fd=accept(listener,NULL,NULL);
    if (fd==BAD_SOCKET) return;
#ifndef _WIN32
    if (fd>=FD_SETSIZE) { close_socket(fd); return; }
#endif
    if (!nonblocking(fd)) { close_socket(fd); return; }
    for (int i=0;i<MAX_CLIENTS;i++) {
        Client *c=&clients[i];
        if (c->active) continue;
        memset(c,0,sizeof(*c));
        c->active=1; c->fd=fd; c->member=-1;
        c->last_seen=c->accepted=time(NULL); pending_write[i]=0;
        if (use_tls && !tls_attach(c)) c->dead=1;
        return;
    }
    close_socket(fd);
}
static void service_client(int index, int readable, int writable) {
    Client *c=&clients[index];
    if (c->ssl && !c->tls_ready) {
        if (ready(c->tls_want,readable,writable) && tls_handshake(c)==-1) c->dead=1;
        return;
    }
    /* 写操作要求重试时优先重试，防止 SSL 状态被其他操作打断。 */
    if (c->output_sent<c->output_len && ready(c->write_want ? c->write_want : 2,readable,writable)) {
        if (!pending_write[index]) pending_write[index]=c->output_len-c->output_sent;
        int count=transport_write(c,c->output+c->output_sent,(int)pending_write[index]);
        if (count>0) {
            c->output_sent+=(size_t)count; pending_write[index]=0;
            if (c->output_sent==c->output_len) c->output_sent=c->output_len=0;
        } else if (count!=-2) c->dead=1;
    }
    if (c->write_want || c->dead || c->closing) return;
    if (ready(c->read_want,readable,writable) || (c->ssl && SSL_pending(c->ssl)>0)) {
        int count=transport_read(c,read_buffer[index],sizeof(read_buffer[index]));
        if (count>0) {
            if ((size_t)count>INPUT_CAP-c->input_len) { c->dead=1; return; }
            memcpy(c->input+c->input_len,read_buffer[index],(size_t)count);
            c->input_len+=(size_t)count;
            c->last_seen=time(NULL);
            if (c->websocket) ws_process(c); else http_process(c);
        } else if (count!=-2) c->dead=1;
    }
}
static int parse_number(const char *text, unsigned long maximum, unsigned *out) {
    char *end; unsigned long value=strtoul(text,&end,10);
    if (!*text || *end || value<1 || value>maximum) return 0;
    *out=(unsigned)value; return 1;
}
int main(int argc, char **argv) {
    unsigned port=8080; const char *bind_address="127.0.0.1", *cert=NULL,*key=NULL;
    const char *account_path = "accounts.sqlite3";
    int anonymous = 0, invite = 0;
#ifndef _WIN32
    umask(0077);
#endif
    for (int i=1;i<argc;i++) {
        if (!strcmp(argv[i], "--anonymous-loopback")) { anonymous = 1; continue; }
        if (!strcmp(argv[i], "--issue-invite")) { invite = 1; continue; }
        if (!strcmp(argv[i], "--log-chat")) { log_chat = 1; continue; }
        if (i+1>=argc) goto usage;
        const char *option=argv[i], *value=argv[++i];
        if (!strcmp(option,"--port")) { if (!parse_number(value,65535,&port)) goto usage; }
        else if (!strcmp(option,"--ttl")) { if (!parse_number(value,86400,&room_ttl)) goto usage; }
        else if (!strcmp(option,"--bind")) bind_address=value;
        else if (!strcmp(option,"--cert")) cert=value;
        else if (!strcmp(option,"--key")) key=value;
        else if (!strcmp(option,"--accounts")) account_path=value;
        else goto usage;
    }
    if (invite) {
        if (anonymous || !accounts_open(account_path)) return 1;
        int success = accounts_invite();
        accounts_close();
        return success ? 0 : 1;
    }
    if (!!cert != !!key || (!anonymous && !cert) ||
        (anonymous && strcmp(bind_address, "127.0.0.1"))) goto usage;
    if (!anonymous && !accounts_open(account_path)) return 1;
    if (!network_init()) return 1;
    if (cert && !tls_init(cert,key)) { network_cleanup(); return 1; }
    socket_t listener=socket(AF_INET,SOCK_STREAM,0);
    if (listener==BAD_SOCKET) { fprintf(stderr,"socket failed\n"); goto failure; }
    int reuse=1;
    setsockopt(listener,SOL_SOCKET,SO_REUSEADDR,(const char*)&reuse,sizeof(reuse));
    struct sockaddr_in address; memset(&address,0,sizeof(address));
    address.sin_family=AF_INET; address.sin_port=htons((unsigned short)port);
    if (inet_pton(AF_INET,bind_address,&address.sin_addr)!=1 ||
        bind(listener,(struct sockaddr*)&address,sizeof(address))!=0 ||
        listen(listener,64)!=0 || !nonblocking(listener)) {
        fprintf(stderr,"listen failed (address/port may be unavailable)\n"); close_socket(listener); goto failure;
    }
#ifndef _WIN32
    if (listener>=FD_SETSIZE) { close_socket(listener); goto failure; }
    signal(SIGPIPE,SIG_IGN);
#endif
    signal(SIGINT,stop_server); signal(SIGTERM,stop_server);
    printf("Chat server %s://%s:%u TTL=%u\n",cert?"https":"http",bind_address,port,room_ttl); fflush(stdout);
    while (!stopping) {
        fd_set reads,writes; FD_ZERO(&reads); FD_ZERO(&writes); FD_SET(listener,&reads);
        socket_t max_fd=listener;
        for (int i=0;i<MAX_CLIENTS;i++) {
            Client *c=&clients[i]; if (!c->active) continue;
            if (c->dead || (c->closing && c->output_len==0)) { disconnect_client(c); continue; }
            if (c->fd>max_fd) max_fd=c->fd;
            if (c->ssl && !c->tls_ready) {
                if (c->tls_want==2) FD_SET(c->fd,&writes); else FD_SET(c->fd,&reads);
            } else {
                if ((!c->closing && c->write_want!=2) || c->write_want==1) FD_SET(c->fd,&reads);
                if (c->read_want==2 || (c->output_len>c->output_sent && c->write_want!=1)) FD_SET(c->fd,&writes);
            }
        }
        struct timeval timeout={0,100000};
#ifdef _WIN32
        int result=select(0,&reads,&writes,NULL,&timeout);
#else
        int result=select(max_fd+1,&reads,&writes,NULL,&timeout);
#endif
        if (result<0) { if (would_block()) continue; fprintf(stderr,"select failed\n"); break; }
        if (FD_ISSET(listener,&reads)) accept_client(listener,cert!=NULL);
        time_t now=time(NULL);
        for (int i=0;i<MAX_CLIENTS;i++) {
            Client *c=&clients[i]; if (!c->active) continue;
            service_client(i,FD_ISSET(c->fd,&reads),FD_ISSET(c->fd,&writes));
            if ((!c->websocket && now-c->accepted>10) || now-c->last_seen>60) c->dead=1;
            if (c->dead || (c->closing && c->output_len==0)) disconnect_client(c);
        }
        room_tick(now);
    }
    for (int i=0;i<MAX_CLIENTS;i++) if (clients[i].active) disconnect_client(&clients[i]);
    close_socket(listener); tls_cleanup(); network_cleanup(); accounts_close(); return 0;
failure:
    tls_cleanup(); network_cleanup(); accounts_close(); return 1;
usage:
    fprintf(stderr,"Usage: chat_server [--bind IPv4] [--port 8080] [--ttl 3600] [--log-chat] [--accounts FILE] --cert FILE --key FILE\n       chat_server [--accounts FILE] --issue-invite\n       chat_server --anonymous-loopback [--port PORT]\n"); return 2;
}
