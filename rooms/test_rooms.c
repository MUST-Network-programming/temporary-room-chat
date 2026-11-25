#include "chat.h"
#include "room_store.h"
#include <assert.h>
#include <stdio.h>
#include <sqlite3.h>
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
    const char *delivery = "{\"type\":\"chat\",\"text\":\"retry me\",\"client_id\":\"0123456789abcdef0123456789abcdef\"}";
    int before_delivery = chats[1];
    msg(4, delivery);
    assert(!strcmp(field(last[4], "type"), "chat_ack"));
    cJSON *confirmed = cJSON_Duplicate(cJSON_GetObjectItemCaseSensitive(last[4], "message"), 1);
    assert(cJSON_IsNumber(cJSON_GetObjectItemCaseSensitive(confirmed, "sent_at")));
    assert(chats[1] == before_delivery + 1);
    msg(4, delivery);
    assert(chats[1] == before_delivery + 1 && cJSON_Compare(confirmed, cJSON_GetObjectItemCaseSensitive(last[4], "message"), 1));
    room_disconnect(&clients[4]); join(5,code,"房主",token);
    msg(5, delivery); assert(!strcmp(field(last[5], "type"), "chat_ack"));
    assert(cJSON_Compare(confirmed, cJSON_GetObjectItemCaseSensitive(last[5], "message"), 1));
    msg(5,"{\"type\":\"chat\",\"text\":\"different\",\"client_id\":\"0123456789abcdef0123456789abcdef\"}");
    err(5, "client_id_conflict"); assert(!strcmp(field(last[5], "client_id"), "0123456789abcdef0123456789abcdef"));
    msg(5,"{\"type\":\"chat\",\"text\":\"\",\"client_id\":\"0123456789abcdef0123456789abcdef\"}");
    err(5, "invalid_text"); assert(cJSON_GetObjectItemCaseSensitive(last[5], "client_id"));
    msg(5,"{\"type\":\"chat\",\"text\":\"bad id\",\"client_id\":\"short\"}"); err(5, "invalid_client_id");
    msg(5,"{\"type\":\"sticker\",\"id\":\"wave\"}");
    assert(cJSON_IsNumber(cJSON_GetObjectItemCaseSensitive(last[1], "sent_at")));
    cJSON_Delete(confirmed);
    room_disconnect(&clients[5]); join(4,code,"房主",token);
    /* Quoted reply, TTL extend, ownership transfer, owner detach+resume, and transfer-leave */
    msg(1,"{\"type\":\"chat\",\"text\":\"收到回复\",\"reply_to\":\"房主\",\"reply_text\":\"你好\",\"client_id\":\"fedcba9876543210fedcba9876543210\"}");
    assert(!strcmp(field(last[4],"reply_to"),"房主") && !strcmp(field(last[4],"reply_text"),"你好"));
    msg(1,"{\"type\":\"extend\"}"); err(1,"forbidden");
    msg(4,"{\"type\":\"extend\"}"); assert(!strcmp(field(last[1],"type"),"extended"));
    msg(1,"{\"type\":\"transfer\",\"target\":\"房主\"}"); err(1,"forbidden");
    msg(4,"{\"type\":\"transfer\",\"target\":\"成员\"}"); assert(clients[1].member>=0 && clients[4].member>=0);
    msg(4,"{\"type\":\"rename\",\"name\":\"已不是房主\"}"); err(4,"forbidden");
    msg(1,"{\"type\":\"transfer\",\"target\":\"房主\"}");
    msg(4,"{\"type\":\"detach\"}"); assert(clients[4].member==-1 && clients[1].member>=0);
    msg(1,"{\"type\":\"chat\",\"text\":\"房主暂离时仍可聊天\"}");
    join(4,code,"房主",token); assert(clients[4].member>=0 && cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(welcome[4],"owner")));
    msg(4,"{\"type\":\"leave\",\"transfer\":\"成员\"}"); assert(clients[4].member==-1 && clients[1].member>=0);
    msg(1,"{\"type\":\"rename\",\"name\":\"新房主改名\"}"); assert(!strcmp(field(last[1],"type"),"renamed"));
    msg(1,"{\"type\":\"leave\"}"); assert(clients[1].member==-1); join(1,code,"成员",NULL); err(1,"room_not_found");
    room_tick(time(NULL)+3601); assert(clients[2].member==-1);
    for(int i=0;i<16;++i) { msg(i,"{\"type\":\"create\",\"nickname\":\"a\"}"); assert(clients[i].member>=0); }
    msg(16,"{\"type\":\"create\",\"nickname\":\"b\"}"); err(16,"capacity");
    room_tick(time(NULL)+3601);
    /* 重开数据库模拟进程重启；原始时间、序号和旧历史必须保持不变。 */
    const char *db = "test-delivery.sqlite";
    remove(db); assert(room_store_open(db));
    assert(room_store_create("instance-one", "ABCDEF", "room", time(NULL)+3600, "owner"));
    cJSON *stored = cJSON_Parse("{\"type\":\"chat\",\"nickname\":\"owner\",\"text\":\"persist\",\"client_id\":\"0123456789abcdef0123456789abcdef\",\"sent_at\":123}");
    assert(room_store_chat("instance-one", "owner", "0123456789abcdef0123456789abcdef", &stored) == 1);
    char sequence[32]; strcpy(sequence, field(stored, "sequence")); cJSON_Delete(stored);
    sqlite3 *fault_db = NULL; assert(sqlite3_open(db, &fault_db) == SQLITE_OK);
    assert(sqlite3_exec(fault_db, "CREATE TRIGGER fail_delivery BEFORE INSERT ON chat_deliveries BEGIN SELECT RAISE(ABORT,'test failure'); END", NULL, NULL, NULL) == SQLITE_OK);
    stored = cJSON_Parse("{\"text\":\"must roll back\"}");
    assert(room_store_chat("instance-one", "owner", "ffffffffffffffffffffffffffffffff", &stored) == 0); cJSON_Delete(stored);
    int remaining; cJSON *after_failure = room_store_page("instance-one", 0, 10, &remaining);
    assert(cJSON_GetArraySize(after_failure) == 1); cJSON_Delete(after_failure);
    assert(sqlite3_exec(fault_db, "DROP TRIGGER fail_delivery", NULL, NULL, NULL) == SQLITE_OK);
    sqlite3_close(fault_db);
    cJSON *legacy = cJSON_Parse("{\"type\":\"chat\",\"text\":\"old\"}");
    assert(room_store_append("instance-one", legacy)); cJSON_Delete(legacy);
    room_store_close(); assert(room_store_open(db));
    stored = cJSON_Parse("{\"text\":\"persist\",\"sent_at\":999}");
    assert(room_store_chat("instance-one", "owner", "0123456789abcdef0123456789abcdef", &stored) == 2);
    assert(!strcmp(sequence, field(stored, "sequence")));
    assert(cJSON_GetObjectItemCaseSensitive(stored, "sent_at")->valuedouble == 123); cJSON_Delete(stored);
    stored = cJSON_Parse("{\"text\":\"changed\"}");
    assert(room_store_chat("instance-one", "owner", "0123456789abcdef0123456789abcdef", &stored) == -1); cJSON_Delete(stored);
    int older; cJSON *page = room_store_page("instance-one", 0, 10, &older);
    assert(cJSON_GetArraySize(page) == 2 && !cJSON_GetObjectItemCaseSensitive(cJSON_GetArrayItem(page,1), "sent_at"));
    cJSON_Delete(page);
    /* 同一幂等键在不同发送者、不同不可变房间实例下互不影响。 */
    stored = cJSON_Parse("{\"text\":\"other sender\"}");
    assert(room_store_chat("instance-one", "other", "0123456789abcdef0123456789abcdef", &stored) == 1); cJSON_Delete(stored);
    assert(room_store_remove("instance-one"));
    assert(room_store_create("instance-two", "ABCDEF", "room", time(NULL)+3600, "owner"));
    stored = cJSON_Parse("{\"text\":\"new room\"}");
    assert(room_store_chat("instance-two", "owner", "0123456789abcdef0123456789abcdef", &stored) == 1); cJSON_Delete(stored);
    room_store_close(); remove(db);
    for(int i=0;i<MAX_CLIENTS;++i) { cJSON_Delete(last[i]); cJSON_Delete(welcome[i]); }
    puts("PASS: isolation / ownership / reconnect / replacement / validation / leave / expiry / capacity");
    return 0;
}
