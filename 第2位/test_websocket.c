#include "chat.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>
static Client c;
static char received[MESSAGE_CAP + 1];
static int messages;
void queue_bytes(Client *p, const void *data, size_t n) {
    assert(p->output_len + n <= OUTPUT_CAP);
    memcpy(p->output + p->output_len, data, n); p->output_len += n;
}
void room_message(Client *p, const char *s, size_t n) {
    (void)p; memcpy(received,s,n); received[n]=0; messages++;
}
static void reset(void) { memset(&c,0,sizeof c); messages=0; }
static void frame(int fin, int op, const unsigned char *s, size_t n) {
    unsigned char *b=c.input+c.input_len; size_t h=6;
    assert(n<126); b[0]=(unsigned char)((fin?128:0)|op); b[1]=(unsigned char)(128|n);
    b[2]=1;b[3]=2;b[4]=3;b[5]=4;
    for(size_t i=0;i<n;i++) b[h+i]=s[i]^b[2+i%4];
    c.input_len+=h+n;
}
int main(void) {
    const char *request="GET /ws HTTP/1.1\r\nHost: localhost\r\nUpgrade: WebSocket\r\nConnection: keep-alive, Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n";
    reset(); assert(ws_handshake(&c,request)==1); assert(c.websocket);
    assert(strstr((char*)c.output,"s3pPLMBiTxaQ9kYGzzhZRbK+xOo=")!=NULL);
    reset(); assert(ws_handshake(&c,"GET /ws HTTP/1.1\r\n\r\n")==0);
    reset(); frame(1,1,(const unsigned char*)"hello",5); size_t full=c.input_len;
    c.input_len=3; ws_process(&c); assert(messages==0); c.input_len=full;
    ws_process(&c); assert(messages==1 && !strcmp(received,"hello") && c.input_len==0);
    reset(); frame(0,1,(const unsigned char*)"\xe4",1);
    frame(1,9,(const unsigned char*)"x",1); frame(1,0,(const unsigned char*)"\xb8\xad",2);
    ws_process(&c); assert(messages==1 && !strcmp(received,"中")); assert(c.output[0]==0x8a);
    reset(); frame(1,1,(const unsigned char*)"\xc0\x80",2); ws_process(&c); assert(c.closing && messages==0);
    reset(); frame(1,0,(const unsigned char*)"bad",3); ws_process(&c); assert(c.closing);
    reset(); c.input[0]=0x81; c.input[1]=0; c.input_len=2; ws_process(&c); assert(c.closing);
    reset(); frame(1,8,(const unsigned char*)"\x03\xe8",2); ws_process(&c); assert(c.closing && c.output[0]==0x88);
    reset(); frame(1,8,(const unsigned char*)"\x03\xed",2); ws_process(&c); assert(c.closing && c.output[3]==0xea);
    reset(); frame(0,9,(const unsigned char*)"",0); ws_process(&c); assert(c.closing);
    reset(); frame(1,2,(const unsigned char*)"bin",3); ws_process(&c); assert(c.closing);
    reset(); c.input[0]=0x81;c.input[1]=0xfe;c.input[2]=0x20;c.input[3]=1;c.input_len=4;
    ws_process(&c);assert(c.closing);
    puts("WebSocket unit tests passed"); return 0;
}
