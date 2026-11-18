/* 缩小内核发送缓冲，真实触发部分写入和 EWOULDBLOCK。 */
#include "chat.h"
#include "platform.h"
#include <assert.h>
#include <string.h>
#include <stdio.h>
int main(void) {
    int pair[2]; assert(socketpair(AF_UNIX,SOCK_STREAM,0,pair)==0);
    assert(nonblocking(pair[0])); assert(nonblocking(pair[1]));
    int capacity=1024; assert(setsockopt(pair[0],SOL_SOCKET,SO_SNDBUF,&capacity,sizeof(capacity))==0);
    Client client; memset(&client,0,sizeof(client)); client.fd=pair[0];
    unsigned char source[131072], received[131072];
    for (size_t i=0;i<sizeof(source);i++) source[i]=(unsigned char)i;
    int first=transport_write(&client,source,sizeof(source));
    assert(first>0 && first<(int)sizeof(source));
    assert(transport_write(&client,source+first,sizeof(source)-(size_t)first)==-2);
    size_t sent=(size_t)first, got=0;
    while(got<sizeof(source)) {
        int n=(int)recv(pair[1],(char*)received+got,sizeof(received)-got,0);
        if(n>0) got+=(size_t)n;
        if(sent<sizeof(source)) {
            n=transport_write(&client,source+sent,(int)(sizeof(source)-sent));
            assert(n>0 || n==-2); if(n>0) sent+=(size_t)n;
        }
    }
    assert(!memcmp(source,received,sizeof(source)));
    close_socket(pair[0]); close_socket(pair[1]);
    puts("PASS real partial send, would-block retry, exact byte reconstruction");
}
