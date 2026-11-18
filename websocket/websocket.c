/* WebSocket 层只负责字节流和消息边界，房间规则交给 room_message。 */
#include "chat.h"
#include <ctype.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <openssl/evp.h>

static int equal_ci(const char *a, const char *b) {
    while (*a && *b) {
        if (tolower((unsigned char)*a++) != tolower((unsigned char)*b++)) return 0;
    }
    return *a == *b;
}
static int has_token(const char *value, const char *wanted) {
    char token[128];
    while (*value) {
        size_t n=0;
        while (*value==' ' || *value=='\t' || *value==',') value++;
        while (*value && *value!=',') {
            if(n+1>=sizeof token) return 0;
            token[n++]=*value++;
        }
        while(n && (token[n-1]==' ' || token[n-1]=='\t')) n--;
        token[n]=0;
        if(equal_ci(token,wanted)) return 1;
    }
    return 0;
}
static int bad_handshake(Client *c) {
    static const char response[]="HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n";
    queue_bytes(c,response,sizeof response-1); c->closing=1; return 0;
}
int ws_handshake(Client *c, const char *request) {
    char buffer[INPUT_CAP], key[25]="", *line, *next;
    int upgrade=0, connection=0, version=0, key_seen=0, host=0;
    size_t length=0;
    while(length<sizeof buffer && request[length]) length++;
    if(length==sizeof buffer) return bad_handshake(c);
    memcpy(buffer,request,length+1);
    line=buffer; next=strstr(line,"\r\n");
    if(!next) return bad_handshake(c);
    *next=0;
    if(strcmp(line,"GET /ws HTTP/1.1")) return bad_handshake(c);
    line=next+2;
    for(;;) {
        char *colon, *end;
        next=strstr(line,"\r\n");
        if(!next) return bad_handshake(c);
        *next=0;
        if(!*line) break;
        colon=strchr(line,':');
        if(!colon || colon==line) return bad_handshake(c);
        /* 禁止折叠首部和非法名称，避免 HTTP 与 WebSocket 对首部理解不同。 */
        for(char *p=line;p<colon;p++)
            if(!isalnum((unsigned char)*p) && !strchr("!#$%&'*+-.^_`|~",*p)) return bad_handshake(c);
        *colon++=0;
        while(*colon==' ' || *colon=='\t') colon++;
        for(char *p=colon;*p;p++)
            if(((unsigned char)*p<32 && *p!='\t') || (unsigned char)*p==127) return bad_handshake(c);
        end=colon+strlen(colon);
        while(end>colon && (end[-1]==' ' || end[-1]=='\t')) *--end=0;
        if(equal_ci(line,"Upgrade")) { if(upgrade || !has_token(colon,"websocket")) return bad_handshake(c); upgrade=1; }
        else if(equal_ci(line,"Connection")) { if(connection || !has_token(colon,"upgrade")) return bad_handshake(c); connection=1; }
        else if(equal_ci(line,"Sec-WebSocket-Version")) { if(version || strcmp(colon,"13")) return bad_handshake(c); version=1; }
        else if(equal_ci(line,"Host")) { if(host || !*colon) return bad_handshake(c); host=1; }
        else if(equal_ci(line,"Sec-WebSocket-Key")) {
            if(key_seen || strlen(colon)!=24) return bad_handshake(c);
            strcpy(key,colon);key_seen=1;
        } else if(equal_ci(line,"Transfer-Encoding") || equal_ci(line,"Content-Length")) {
            /* 升级请求没有请求体；拒绝这些首部以避免字节边界歧义。 */
            return bad_handshake(c);
        }
        line=next+2;
    }
    if(!host || !upgrade || !connection || !version || !key_seen) return bad_handshake(c);
    unsigned char decoded[32], canonical[32], digest[EVP_MAX_MD_SIZE];
    if(key[22]!='=' || key[23]!='=') return bad_handshake(c);
    for(int i=0;i<22;i++) if(!isalnum((unsigned char)key[i]) && key[i]!='+' && key[i]!='/') return bad_handshake(c);
    if(EVP_DecodeBlock(decoded,(unsigned char*)key,24)!=18) return bad_handshake(c);
    EVP_EncodeBlock(canonical,decoded,16);
    if(strcmp((char*)canonical,key)) return bad_handshake(c);
    char source[64], accept[64], response[256]; unsigned int digest_len=0;
    snprintf(source,sizeof source,"%s258EAFA5-E914-47DA-95CA-C5AB0DC85B11",key);
    if(!EVP_Digest(source,strlen(source),digest,&digest_len,EVP_sha1(),NULL)) return bad_handshake(c);
    EVP_EncodeBlock((unsigned char*)accept,digest,(int)digest_len);
    int n=snprintf(response,sizeof response,"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: %s\r\n\r\n",accept);
    queue_bytes(c,response,(size_t)n); c->websocket=1; return 1;
}
void ws_send(Client *c, int opcode, const void *data, size_t len) {
    unsigned char header[10];size_t n=2;
    header[0]=(unsigned char)(0x80|opcode);
    if(len<126) header[1]=(unsigned char)len;
    else if(len<=65535) { header[1]=126;header[2]=(unsigned char)(len>>8);header[3]=(unsigned char)len;n=4; }
    else { header[1]=127; for(int i=0;i<8;i++) header[2+i]=(unsigned char)((uint64_t)len>>(56-8*i));n=10; }
    queue_bytes(c,header,n); if(len) queue_bytes(c,data,len);
}
void send_json(Client *c, cJSON *json) {
    if(!json) { c->dead=1; return; }
    char *text=cJSON_PrintUnformatted(json);
    if(text) { ws_send(c,1,text,strlen(text));cJSON_free(text); }
    else c->dead=1;
    cJSON_Delete(json);
}
void send_error(Client *c, const char *code, const char *message) {
    cJSON *json=cJSON_CreateObject();
    if(!json || !cJSON_AddStringToObject(json,"type","error") || !cJSON_AddStringToObject(json,"code",code) || !cJSON_AddStringToObject(json,"message",message)) {
        cJSON_Delete(json); c->dead=1; return;
    }
    send_json(c,json);
}
/* 验证完整消息：禁止过长编码、代理区和超出 U+10FFFF 的编码。分片中允许截断字符。 */
static int valid_utf8(const unsigned char *s,size_t n) {
    size_t i=0;
    while(i<n) {
        unsigned int first=s[i++], value, minimum;int remaining;
        if(first<128) continue;
        if(first>=0xc2 && first<=0xdf) { remaining=1;value=first&31;minimum=128; }
        else if(first>=0xe0 && first<=0xef) { remaining=2;value=first&15;minimum=2048; }
        else if(first>=0xf0 && first<=0xf4) { remaining=3;value=first&7;minimum=65536; }
        else return 0;
        if(n-i<(size_t)remaining) return 0;
        while(remaining--) { unsigned int b=s[i++];if((b&0xc0)!=0x80) return 0;value=(value<<6)|(b&63); }
        if(value<minimum || value>0x10ffff || (value>=0xd800 && value<=0xdfff)) return 0;
    }
    return 1;
}
static void fail_frame(Client *c, unsigned int status) {
    unsigned char payload[2]={(unsigned char)(status>>8),(unsigned char)status};
    ws_send(c,8,payload,2);c->closing=1;
}
static int valid_close(unsigned int code) {
    return (code>=1000 && code<=1014 && code!=1004 && code!=1005 && code!=1006) || (code>=3000 && code<=4999);
}
void ws_process(Client *c) {
    while(!c->closing && !c->dead && c->input_len>=2) {
        unsigned char *b=c->input;
        int fin=(b[0]&0x80)!=0, op=b[0]&15, control=(op&8)!=0;
        uint64_t length=b[1]&127;size_t header=2;
        if((b[0]&0x70) || !(b[1]&0x80) || (op!=0 && op!=1 && op!=2 && op!=8 && op!=9 && op!=10)) { fail_frame(c,1002);return; }
        if(control && (!fin || length>125)) { fail_frame(c,1002);return; }
        if(length==126) {
            if(c->input_len<4) return;
            length=((uint64_t)b[2]<<8)|b[3];header=4;
            if(length<126) { fail_frame(c,1002);return; }
        } else if(length==127) {
            if(c->input_len<10) return;
            if(b[2]&128) { fail_frame(c,1002);return; }
            length=0;for(int i=2;i<10;i++) length=(length<<8)|b[i];header=10;
            if(length<=65535) { fail_frame(c,1002);return; }
        }
        if(length>MESSAGE_CAP || (!control && length>MESSAGE_CAP-c->message_len)) { fail_frame(c,1009);return; }
        if(op==2) { fail_frame(c,1003);return; }
        if(!control && ((op==0 && !c->fragmented) || (op==1 && c->fragmented))) { fail_frame(c,1002);return; }
        if(c->input_len<header+4+(size_t)length) return;
        unsigned char *mask=b+header,*payload=mask+4;
        for(size_t i=0;i<(size_t)length;i++) payload[i]^=mask[i%4];
        if(op==8) {
            if(length==1) { fail_frame(c,1002);return; }
            if(length>=2) {
                unsigned int status=((unsigned int)payload[0]<<8)|payload[1];
                if(!valid_close(status)) { fail_frame(c,1002);return; }
                if(!valid_utf8(payload+2,(size_t)length-2)) { fail_frame(c,1007);return; }
            }
            ws_send(c,8,payload,(size_t)length);c->closing=1;return;
        } else if(op==9) ws_send(c,10,payload,(size_t)length);
        else if(op!=10) {
            memcpy(c->message+c->message_len,payload,(size_t)length);c->message_len+=(size_t)length;
            c->fragmented=!fin;
            if(fin) {
                if(!valid_utf8(c->message,c->message_len)) { fail_frame(c,1007);return; }
                /* 使用显式长度，业务层不得假定消息末尾有 NUL。 */
                room_message(c,(const char*)c->message,c->message_len);c->message_len=0;
            }
        }
        size_t consumed=header+4+(size_t)length;
        c->input_len-=consumed;memmove(c->input,c->input+consumed,c->input_len);
    }
}
