#include "chat.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>
Client clients[MAX_CLIENTS];
unsigned room_ttl = 3600;
static cJSON *last[MAX_CLIENTS], *welcome[MAX_CLIENTS];
static int chats[MAX_CLIENTS];
void send_json(Client *c, cJSON *j) {
    int i = (int)(c - clients); assert(i >= 0 && i < MAX_CLIENTS && j);
    const char *t = cJSON_GetObjectItemCaseSensitive(j,"type")->valuestring;
    if (!strcmp(t,"joined")) { cJSON_Delete(welcome[i]); welcome[i] = cJSON_Duplicate(j,1); }
    if (!strcmp(t,"chat")) ++chats[i];
    cJSON_Delete(last[i]); last[i] = j;
}
void send_error(Client *c, const char *code, const char *message) {
    cJSON *j = cJSON_CreateObject(); cJSON_AddStringToObject(j,"type","error");
    cJSON_AddStringToObject(j,"code",code); cJSON_AddStringToObject(j,"message",message); send_json(c,j);
}
static void msg(int i, const char *s) { room_message(&clients[i],s,strlen(s)); }
static const char *field(cJSON *j, const char *key) { return cJSON_GetObjectItemCaseSensitive(j,key)->valuestring; }
static void err(int i,const char *code) { assert(!strcmp(field(last[i],"type"),"error")); assert(!strcmp(field(last[i],"code"),code)); }
static void join(int i,const char *room,const char *name,const char *token) {
    char s[512];
    if (token) snprintf(s,sizeof s,"{\"type\":\"join\",\"room\":\"%s\",\"nickname\":\"%s\",\"token\":\"%s\"}",room,name,token);
    else snprintf(s,sizeof s,"{\"type\":\"join\",\"room\":\"%s\",\"nickname\":\"%s\"}",room,name);
    msg(i,s);
}
int main(void) {
    for (int i=0;i<MAX_CLIENTS;++i) clients[i].member=-1;
    msg(0,"{\"type\":\"create\",\"nickname\":\"房主\"}");
    assert(welcome[0]); char code[7],token[65]; strcpy(code,field(welcome[0],"room")); strcpy(token,field(welcome[0],"token"));
    assert(strlen(code)==6 && strlen(token)==64);
    join(1,code,"成员",NULL); assert(welcome[1]);
    msg(2,"{\"type\":\"create\",\"nickname\":\"另一个房主\"}");
    msg(0,"{\"type\":\"chat\",\"text\":\"你好\"}"); assert(chats[0]==1 && chats[1]==1 && chats[2]==0);
    msg(1,"{\"type\":\"close\"}"); err(1,"forbidden");
    join(3,code,"房主",NULL); err(3,"nickname_taken");
    join(3,code,"房主","bad"); err(3,"invalid_token");
    join(3,code,"房主",token); assert(cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(welcome[3],"owner")));
    assert(clients[0].member==-1 && clients[0].closing);
    room_disconnect(&clients[0]); room_disconnect(&clients[0]); assert(clients[3].member>=0);
    room_disconnect(&clients[3]);
    join(4,code,"房主",token); assert(welcome[4]);
    msg(4,"{\"type\":\"chat\",\"text\":\"a\\u0000b\"}"); err(4,"invalid_json");
    msg(4,"{\"type\":\"chat\",\"text\":\"a\\\\u0000b\"}"); assert(chats[4]==2);
    msg(4,"{\"type\":\"chat\",\"text\":\"a\",\"text\":\"b\"}"); err(4,"invalid_json");
    msg(4,"{\"type\":\"ping\"}junk"); err(4,"invalid_json");
    msg(4,"{\"type\":\"ping\"} \n"); assert(!strcmp(field(last[4],"type"),"pong"));
    msg(4,"{\"type\":\"chat\",\"text\":42}"); err(4,"invalid_json");
    msg(4,"{\"type\":\"chat\",\"text\":\"\xc0\xaf\"}"); err(4,"invalid_text");
    char member_token[65]; strcpy(member_token,field(welcome[1],"token"));
    msg(1,"{\"type\":\"leave\"}"); join(1,code,"成员",member_token); err(1,"invalid_token");
    join(1,code,"成员",NULL); assert(clients[1].member>=0);
    msg(4,"{\"type\":\"leave\"}"); assert(clients[1].member==-1); join(1,code,"成员",NULL); err(1,"room_not_found");
    room_tick(time(NULL)+3601); assert(clients[2].member==-1);
    for(int i=0;i<16;++i) { msg(i,"{\"type\":\"create\",\"nickname\":\"a\"}"); assert(clients[i].member>=0); }
    msg(16,"{\"type\":\"create\",\"nickname\":\"b\"}"); err(16,"capacity");
    room_tick(time(NULL)+3601);
    for(int i=0;i<MAX_CLIENTS;++i) { cJSON_Delete(last[i]); cJSON_Delete(welcome[i]); }
    puts("PASS: isolation / ownership / reconnect / replacement / validation / leave / expiry / capacity");
    return 0;
}
