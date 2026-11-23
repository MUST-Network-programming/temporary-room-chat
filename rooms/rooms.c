#include "chat.h"
#include "accounts.h"
#include <openssl/rand.h>
#include <string.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <openssl/crypto.h>

#define ROOM_LIMIT 16
#define SESSION_LIMIT 256
#define ROOM_MEMBERS 64

#define HISTORY_LIMIT 100
typedef struct {
    int used;
    char code[7], name[65], instance[65];
    time_t expires;
    cJSON *history[HISTORY_LIMIT];
    unsigned next_message, message_count;
} Room;
typedef struct {
    int used, room, owner;
    char nickname[49], token[65];
    Client *connection;
} Member;
static Room rooms[ROOM_LIMIT];
static Member members[SESSION_LIMIT];

/* 会话与 TCP 连接分开保存：断网只清空 connection，令牌仍可恢复身份。 */
static int member_of(Client *c) {
    int i = c->member;
    return i >= 0 && i < SESSION_LIMIT && members[i].used &&
           members[i].connection == c ? i : -1;
}
static cJSON *event(const char *type) {
    cJSON *j = cJSON_CreateObject();
    cJSON_AddStringToObject(j, "type", type);
    return j;
}
int log_chat;

static void log_room_event(const Room *room, const char *type, const char *nickname,
                           const char *field, const char *value) {
    if (!log_chat) return;
    /* 用 JSON 转义换行与控制字符，让每个事件只占终端一行。 */
    cJSON *entry = event(type);
    cJSON_AddNumberToObject(entry, "time", (double)time(NULL));
    cJSON_AddStringToObject(entry, "room", room->code);
    if (nickname) cJSON_AddStringToObject(entry, "nickname", nickname);
    if (field) cJSON_AddStringToObject(entry, field, value);
    char *line = cJSON_PrintUnformatted(entry);
    if (line) {
        fprintf(stderr, "[room] %s\n", line);
        fflush(stderr);
        cJSON_free(line);
    }
    cJSON_Delete(entry);
}
static void broadcast(int r, cJSON *j) {
    for (int i = 0; i < SESSION_LIMIT; ++i)
        if (members[i].used && members[i].room == r && members[i].connection)
            send_json(members[i].connection, cJSON_Duplicate(j, 1));
    cJSON_Delete(j);
}
static void online_list(int r) {
    cJSON *j = event("members"), *a = cJSON_AddArrayToObject(j, "members");
    for (int i = 0; i < SESSION_LIMIT; ++i)
        if (members[i].used && members[i].room == r && members[i].connection)
            cJSON_AddItemToArray(a, cJSON_CreateString(members[i].nickname));
    broadcast(r, j);
}
static void close_room(int r, const char *reason) {
    log_room_event(&rooms[r], "close", NULL, "reason", reason);
    cJSON *j = event("closed");
    cJSON_AddStringToObject(j, "reason", reason);
    broadcast(r, j);
    for (int i = 0; i < SESSION_LIMIT; ++i) {
        if (!members[i].used || members[i].room != r) continue;
        if (members[i].connection) members[i].connection->member = -1;
        memset(&members[i], 0, sizeof members[i]);
    }
    for (unsigned i = 0; i < HISTORY_LIMIT; ++i) cJSON_Delete(rooms[r].history[i]);
    memset(&rooms[r], 0, sizeof rooms[r]);
}
void room_tick(time_t now) {
    for (int r = 0; r < ROOM_LIMIT; ++r)
        if (rooms[r].used && now >= rooms[r].expires) close_room(r, "expired");
}
void room_disconnect(Client *c) {
    int i = member_of(c);
    c->member = -1;
    if (i < 0) return;
    int r = members[i].room;
    log_room_event(&rooms[r], "disconnect", members[i].nickname, NULL, NULL);
    members[i].connection = NULL;
    online_list(r);
}
/* 拒绝过长、非法 UTF-8、空字符串和控制字符；长度按 UTF-8 字节计数。 */
static int valid_string(const char *s, size_t max, int nickname) {
    size_t n = strlen(s);
    if (!n || n > max) return 0;
    const unsigned char *p = (const unsigned char *)s;
    for (size_t i = 0; i < n;) {
        unsigned char b = p[i++];
        if (b < 0x80) {
            if (b < 32 && (nickname || (b != '\n' && b != '\t' && b != '\r'))) return 0;
            if (b == 127) return 0;
            continue;
        }
        unsigned need; uint32_t cp, min;
        if (b >= 0xc2 && b <= 0xdf) { need = 1; cp = b & 31; min = 128; }
        else if (b >= 0xe0 && b <= 0xef) { need = 2; cp = b & 15; min = 2048; }
        else if (b >= 0xf0 && b <= 0xf4) { need = 3; cp = b & 7; min = 65536; }
        else return 0;
        if (i + need > n) return 0;
        while (need--) { if ((p[i] & 0xc0) != 0x80) return 0; cp = (cp << 6) | (p[i++] & 63); }
        if (cp < min || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return 0;
    }
    return 1;
}
static const char *string_field(cJSON *j, const char *name) {
    cJSON *v = cJSON_GetObjectItemCaseSensitive(j, name);
    return cJSON_IsString(v) ? v->valuestring : NULL;
}
/* cJSON 字符串采用 C NUL 结尾；在解析前拒绝 JSON 的 \u0000，避免截断绕过验证。
   跳过双反斜杠，因此合法文本 "\\u0000" 不会被误拒绝。 */
static int raw_valid(const char *text, size_t len) {
    if (!len || len > MESSAGE_CAP || memchr(text, 0, len)) return 0;
    for (size_t i = 0; i < len; ++i) {
        if (text[i] != '\\') continue;
        if (i + 5 < len && text[i+1] == 'u' && !memcmp(text+i+2, "0000", 4)) return 0;
        ++i;
    }
    return 1;
}
static int schema(cJSON *j, const char *type) {
    if (!cJSON_IsObject(j)) return 0;
    for (cJSON *v = j->child; v; v = v->next) {
        if (!v->string || !cJSON_IsString(v)) return 0;
        for (cJSON *w = v->next; w; w = w->next)
            if (w->string && !strcmp(v->string, w->string)) return 0;
        if (!strcmp(v->string, "type")) continue;
        if ((!strcmp(type, "login") || !strcmp(type, "register")) &&
            (!strcmp(v->string, "name") || !strcmp(v->string, "password"))) continue;
        if (!strcmp(type, "register") && (!strcmp(v->string, "invite") || !strcmp(v->string, "email"))) continue;
        if (!strcmp(type, "assistant_rpc") && (!strcmp(v->string,"secret") || !strcmp(v->string,"token") || !strcmp(v->string,"text"))) continue;
        if (!strcmp(type, "authenticate") && !strcmp(v->string, "token")) continue;
        if ((!strcmp(type, "create") || !strcmp(type, "join")) && !strcmp(v->string, "nickname")) continue;
        if (!strcmp(type, "join") && (!strcmp(v->string, "room") || !strcmp(v->string, "token"))) continue;
        if (!strcmp(type, "chat") && !strcmp(v->string, "text")) continue;
        if (!strcmp(type, "rename") && !strcmp(v->string, "name")) continue;
        if (!strcmp(type, "sticker") && !strcmp(v->string, "id")) continue;
        return 0;
    }
    return 1;
}
static int random_code(char out[7]) {
    /* 32 字符字母表整除 256，因此不会引入取模偏差；避开易混淆字符。 */
    static const char alphabet[] = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    unsigned char b[6];
    for (int attempt = 0; attempt < 128; ++attempt) {
        if (RAND_bytes(b, sizeof b) != 1) return 0;
        for (int k = 0; k < 6; ++k) out[k] = alphabet[b[k] & 31];
        out[6] = 0;
        int collision = 0;
        for (int r = 0; r < ROOM_LIMIT; ++r)
            if (rooms[r].used && !strcmp(rooms[r].code, out)) collision = 1;
        if (!collision) return 1;
    }
    return 0;
}
static int random_token(char out[65]) {
    static const char hex[] = "0123456789abcdef";
    unsigned char b[32];
    if (RAND_bytes(b, sizeof b) != 1) return 0;
    for (int k = 0; k < 32; ++k) { out[k*2] = hex[b[k] >> 4]; out[k*2+1] = hex[b[k] & 15]; }
    out[64] = 0;
    return 1;
}
static void joined(Client *c, int i) {
    Member *m = &members[i]; Room *r = &rooms[m->room];
    cJSON *j = event("joined");
    cJSON_AddStringToObject(j, "room", r->code);
    cJSON_AddStringToObject(j, "nickname", m->nickname);
    if (!accounts_active()) cJSON_AddStringToObject(j, "token", m->token);
    cJSON_AddStringToObject(j, "assistant_token", m->token);
    cJSON_AddBoolToObject(j, "owner", m->owner);
    cJSON_AddNumberToObject(j, "expires", (double)r->expires);
    cJSON_AddStringToObject(j, "name", r->name);
    send_json(c, j);
    /* 逐条回放，避免把 100 条记录塞进一个超长 WebSocket 帧。 */
    unsigned start = (r->next_message + HISTORY_LIMIT - r->message_count) % HISTORY_LIMIT;
    for (unsigned k = 0; k < r->message_count; ++k)
        send_json(c, cJSON_Duplicate(r->history[(start + k) % HISTORY_LIMIT], 1));
    online_list(m->room);
}
static void enter(Client *c, cJSON *j, int create) {
    int account_mode = accounts_active();
    if (account_mode && (string_field(j, "nickname") || string_field(j, "token"))) {
        send_error(c, "identity_override", "入房身份由登录账号确定");
        return;
    }
    const char *nickname = account_mode ? c->account : string_field(j, "nickname");
    if (!nickname || !valid_string(nickname, 48, 1)) { send_error(c,"invalid_nickname","昵称需要 1–48 个 UTF-8 字节"); return; }
    if (member_of(c) >= 0) { send_error(c,"already_joined","请先离开当前房间"); return; }
    int r = -1, free_member = -1;
    for (int i = 0; i < SESSION_LIMIT; ++i) if (!members[i].used) { free_member = i; break; }
    if (create) {
        for (int k = 0; k < ROOM_LIMIT; ++k) if (!rooms[k].used) { r = k; break; }
        if (r < 0 || free_member < 0) { send_error(c,"capacity","房间或会话已满"); return; }
    } else {
        const char *code = string_field(j,"room"), *token = string_field(j,"token");
        if (!code || strlen(code) != 6) { send_error(c,"invalid_room","房间码必须为 6 位"); return; }
        for (int k = 0; k < ROOM_LIMIT; ++k) if (rooms[k].used && !strcmp(rooms[k].code,code)) { r = k; break; }
        if (r < 0) { send_error(c,"room_not_found","房间不存在或已到期"); return; }
        int count = 0, duplicate = 0;
        for (int i = 0; i < SESSION_LIMIT; ++i) {
            Member *m = &members[i];
            if (!m->used || m->room != r) continue;
            ++count;
            if ((account_mode && !strcmp(m->nickname, nickname)) ||
                (token && !strcmp(m->token,token))) {
                if (strcmp(m->nickname,nickname)) { send_error(c,"invalid_token","令牌与昵称不匹配"); return; }
                /* 先解除旧连接关联，再绑定新连接。旧连接稍后断开不会误删新连接。 */
                if (m->connection && m->connection != c) {
                    Client *old = m->connection; old->member = -1;
                    send_error(old,"session_replaced","会话已在另一连接恢复");
                    old->closing = 1;
                }
                m->connection = c; c->member = i;
                log_room_event(&rooms[r], "resume", nickname, NULL, NULL);
                joined(c,i); return;
            }
            if (!strcmp(m->nickname,nickname)) duplicate = 1;
        }
        if (token) { send_error(c,"invalid_token","恢复令牌无效"); return; }
        if (duplicate) { send_error(c,"nickname_taken","昵称已被使用"); return; }
        if (count >= ROOM_MEMBERS || free_member < 0) { send_error(c,"capacity","房间或会话已满"); return; }
    }
    char token[65], code[7], instance[65];
    if (!random_token(token) || (create && (!random_code(code) || !random_token(instance)))) { send_error(c,"random_failed","安全随机数生成失败"); return; }
    if (create) { rooms[r].used = 1; strcpy(rooms[r].instance,instance); strcpy(rooms[r].code,code); strcpy(rooms[r].name, "同行房间"); rooms[r].expires = time(NULL) + room_ttl; }
    Member *m = &members[free_member];
    m->used = 1; m->room = r; m->owner = create; m->connection = c;
    strcpy(m->nickname,nickname); strcpy(m->token,token); c->member = free_member;
    log_room_event(&rooms[r], create ? "create" : "join", nickname, NULL, NULL);
    joined(c,free_member);
}
static void publish_message(Member *member, const char *type, const char *field, const char *value) {
    Room *room = &rooms[member->room];
    log_room_event(room, type, member->nickname, field, value);
    cJSON *out = event(type);
    cJSON_AddStringToObject(out, "nickname", member->nickname);
    cJSON_AddStringToObject(out, field, value);
    cJSON *saved = cJSON_Duplicate(out, 1);
    if (saved) {
        cJSON_Delete(room->history[room->next_message]);
        room->history[room->next_message] = saved;
        room->next_message = (room->next_message + 1) % HISTORY_LIMIT;
        if (room->message_count < HISTORY_LIMIT) ++room->message_count;
    }
    broadcast(member->room, out);
}
static int valid_sticker(const char *id) {
    return id && (!strcmp(id, "wave") || !strcmp(id, "ok") ||
                  !strcmp(id, "party") || !strcmp(id, "heart"));
}
/* Worker-only RPC. Secret is supplied from the environment, never from a browser.
   Every call resolves the original room membership token against live C state. */
static void assistant_rpc(Client *c, cJSON *j) {
    const char *secret = getenv("ASSISTANT_SHARED_SECRET");
    const char *given = string_field(j, "secret"), *token = string_field(j, "token");
    if (!secret || strlen(secret)<32 || !given || strlen(given)!=strlen(secret) ||
        CRYPTO_memcmp(secret,given,strlen(secret)) || !token) {
        send_error(c,"forbidden","助手后台未授权"); return;
    }
    int i=-1;
    for (int k=0;k<SESSION_LIMIT;k++)
        if (members[k].used && strlen(token)==64 && !CRYPTO_memcmp(token,members[k].token,64)) { i=k; break; }
    if (i<0) { send_error(c,"not_joined","房间成员会话已失效"); return; }
    Member *m=&members[i]; Room *r=&rooms[m->room];
    const char *body=string_field(j,"text");
    if (body) {
        if (!m->owner || !valid_string(body,2048,0)) { send_error(c,"forbidden","只有房主可以发布有效行程"); return; }
        Member assistant=*m; strcpy(assistant.nickname,"行程助手");
        publish_message(&assistant,"chat","text",body);
    }
    cJSON *out=event("assistant_context");
    cJSON_AddStringToObject(out,"room",r->code);
    cJSON_AddStringToObject(out,"instance",r->instance);
    cJSON_AddStringToObject(out,"nickname",m->nickname);
    cJSON_AddBoolToObject(out,"owner",m->owner);
    cJSON_AddNumberToObject(out,"expires",(double)r->expires);
    cJSON *history=cJSON_AddArrayToObject(out,"history");
    unsigned start=(r->next_message+HISTORY_LIMIT-r->message_count)%HISTORY_LIMIT;
    for (unsigned k=0;k<r->message_count;k++)
        cJSON_AddItemToArray(history,cJSON_Duplicate(r->history[(start+k)%HISTORY_LIMIT],1));
    send_json(c,out);
}
void room_message(Client *c, const char *text, size_t len) {
    room_tick(time(NULL));
    if (!raw_valid(text,len)) { send_error(c,"invalid_json","消息为空、过长或含 NUL"); return; }
    const char *end = NULL;
    cJSON *j = cJSON_ParseWithLengthOpts(text,len,&end,0);
    const char *type = j ? string_field(j,"type") : NULL;
    while (end && end < text + len && (*end == ' ' || *end == '\r' || *end == '\n' || *end == '\t')) ++end;
    if (!j || end != text + len || !type || !schema(j,type)) {
        cJSON_Delete(j); send_error(c,"invalid_json","JSON 格式、字段类型或重复字段错误"); return;
    }
    if (!strcmp(type, "assistant_rpc")) { assistant_rpc(c,j);
    } else if (!strcmp(type, "auth_mode")) {
        cJSON *mode = event("auth_mode");
        cJSON_AddBoolToObject(mode, "required", accounts_active());
        send_json(c, mode);
    } else if (accounts_handle(c, j, type)) {
        const char *password = string_field(j, "password");
        const char *invite = string_field(j, "invite");
        if (password) OPENSSL_cleanse((void *)password, strlen(password));
        if (invite) OPENSSL_cleanse((void *)invite, strlen(invite));
        cJSON_Delete(j);
        return;
    } else if (!strcmp(type,"ping")) send_json(c,event("pong"));
    else if (!strcmp(type,"create") || !strcmp(type,"join")) enter(c,j,!strcmp(type,"create"));
    else if (!strcmp(type,"chat") || !strcmp(type,"leave") || !strcmp(type,"close") || !strcmp(type,"rename") || !strcmp(type,"sticker")) {
        int i = member_of(c);
        if (i < 0) send_error(c,"not_joined","请先加入房间");
        else {
            int r = members[i].room;
            if (!strcmp(type,"chat")) {
                const char *body = string_field(j,"text");
                if (!body || !valid_string(body,2048,0)) send_error(c,"invalid_text","消息需要 1–2048 个合法 UTF-8 字节");
                else publish_message(&members[i], "chat", "text", body);
            } else if (!strcmp(type, "sticker")) {
                const char *id = string_field(j, "id");
                if (!valid_sticker(id)) send_error(c, "invalid_sticker", "没有这个贴图");
                else publish_message(&members[i], "sticker", "id", id);
            } else if (!strcmp(type, "rename")) {
                const char *name = string_field(j, "name");
                if (!members[i].owner) send_error(c, "forbidden", "只有房主可以改名");
                else if (!name || !valid_string(name, 64, 1) || !name[strspn(name, " ")])
                    send_error(c, "invalid_name", "群名需要 1–64 个合法 UTF-8 字节");
                else {
                    strcpy(rooms[r].name, name);
                    log_room_event(&rooms[r], "rename", members[i].nickname, "name", name);
                    cJSON *out = event("renamed");
                    cJSON_AddStringToObject(out, "name", name);
                    broadcast(r, out);
                }
            } else if (!strcmp(type,"close") && !members[i].owner) send_error(c,"forbidden","只有房主可以关闭房间");
            else if (members[i].owner) close_room(r,!strcmp(type,"leave") ? "owner_left" : "owner_closed");
            else {
                log_room_event(&rooms[r], "leave", members[i].nickname, NULL, NULL);
                memset(&members[i],0,sizeof members[i]); c->member = -1;
                cJSON *out = event("closed"); cJSON_AddStringToObject(out,"reason","left"); send_json(c,out); online_list(r);
            }
        }
    } else send_error(c,"unknown_type","未知消息类型");
    cJSON_Delete(j);
}
