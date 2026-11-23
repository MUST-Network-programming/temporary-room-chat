#include "chat.h"
#include "accounts.h"
#include "room_store.h"
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
#define HISTORY_PAGE 20
#define BOT_NAME "群聊助手"
#define BOT_PENDING_LIMIT 4
#define BOT_CONTEXT_LIMIT 20
#define NOTICE_LIMIT 64
typedef struct {
    char id[65], asker[65];
    time_t deadline;
} BotRequest;
typedef struct {
    char id[33];
    unsigned revision;
} NoticeCard;
typedef struct {
    int used, has_older;
    char code[7], name[65], instance[65];
    time_t expires;
    cJSON *history[HISTORY_LIMIT];
    unsigned next_message, message_count;
    BotRequest bot_requests[BOT_PENDING_LIMIT];
    NoticeCard notices[NOTICE_LIMIT];
} Room;
typedef struct {
    int used, room, owner;
    char nickname[49], token[65];
    Client *connection;
    time_t next_bot_request;
} Member;
static Room rooms[ROOM_LIMIT];
static Member members[SESSION_LIMIT];
static Client *bot_worker;

static void bot_error(int r, const char *asker, const char *message) {
    for (int i = 0; i < SESSION_LIMIT; ++i)
        if (members[i].used && members[i].room == r && members[i].connection &&
            !strcmp(members[i].token, asker)) {
            send_error(members[i].connection, "bot_unavailable", message);
            return;
        }
}

static void clear_bot_requests(void) {
    for (int r = 0; r < ROOM_LIMIT; ++r) {
        if (!rooms[r].used) continue;
        for (int k = 0; k < BOT_PENDING_LIMIT; ++k) {
            BotRequest *request = &rooms[r].bot_requests[k];
            if (!request->deadline) continue;
            bot_error(r, request->asker, "群聊助手连接中断，请稍后重试");
            memset(request, 0, sizeof *request);
        }
    }
}

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
    static int cleanup_pending;
    static time_t next_cleanup;
    for (int r = 0; r < ROOM_LIMIT; ++r) {
        if (!rooms[r].used) continue;
        if (now >= rooms[r].expires) {
            if (!room_store_remove(rooms[r].instance)) cleanup_pending = 1;
            close_room(r, "expired");
            continue;
        }
        for (int k = 0; k < BOT_PENDING_LIMIT; ++k) {
            BotRequest *request = &rooms[r].bot_requests[k];
            if (!request->deadline || now < request->deadline) continue;
            bot_error(r, request->asker, "群聊助手响应超时，请稍后重试");
            memset(request, 0, sizeof *request);
        }
    }
    if (cleanup_pending && now >= next_cleanup) {
        cleanup_pending = !room_store_expire(now);
        if (cleanup_pending) fprintf(stderr, "Could not purge expired rooms; will retry\n");
        next_cleanup = now + 10;
    }
}
void room_disconnect(Client *c) {
    if (bot_worker == c) {
        bot_worker = NULL;
        clear_bot_requests();
    }
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
        if (!strcmp(type, "bot_watch") && !strcmp(v->string, "secret")) continue;
        if (!strcmp(type, "bot_reply") && (!strcmp(v->string, "instance") ||
            !strcmp(v->string, "id") || !strcmp(v->string, "text"))) continue;
        if ((!strcmp(type, "account_identity") || !strcmp(type, "notice_room")) &&
            (!strcmp(v->string, "secret") || !strcmp(v->string, "login"))) continue;
        if (!strcmp(type, "notice_room") && !strcmp(v->string, "token")) continue;
        if (!strcmp(type, "notice_card") && (!strcmp(v->string, "secret") ||
            !strcmp(v->string, "instance") || !strcmp(v->string, "id") ||
            !strcmp(v->string, "title") || !strcmp(v->string, "text") ||
            !strcmp(v->string, "due") || !strcmp(v->string, "revision") ||
            !strcmp(v->string, "status"))) continue;
        if (!strcmp(type, "authenticate") && !strcmp(v->string, "token")) continue;
        if ((!strcmp(type, "create") || !strcmp(type, "join")) && !strcmp(v->string, "nickname")) continue;
        if (!strcmp(type, "join") && (!strcmp(v->string, "room") || !strcmp(v->string, "token"))) continue;
        if (!strcmp(type, "chat") && !strcmp(v->string, "text")) continue;
        if (!strcmp(type, "history") && !strcmp(v->string, "before")) continue;
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
static int restore_member(const char *instance, const char *code, const char *name,
                          time_t expires, const char *nickname, int owner) {
    if (!instance || strlen(instance) != 64 || !code || strlen(code) != 6 ||
        !name || !valid_string(name, 64, 1) || !nickname || !valid_string(nickname, 24, 1)) return 0;
    int r = 0;
    while (r < ROOM_LIMIT && rooms[r].used && strcmp(rooms[r].instance, instance)) ++r;
    if (r == ROOM_LIMIT) return 0;
    Room *room = &rooms[r];
    if (!room->used) {
        if (!owner) return 0;
        room->used = 1;
        strcpy(room->instance, instance);
        strcpy(room->code, code);
        strcpy(room->name, name);
        room->expires = expires;
    }
    int i = 0;
    while (i < SESSION_LIMIT && members[i].used) ++i;
    if (i == SESSION_LIMIT || !random_token(members[i].token)) return 0;
    members[i].used = 1;
    members[i].room = r;
    members[i].owner = owner;
    strcpy(members[i].nickname, nickname);
    return 1;
}

static void remember_message(Room *room, cJSON *message) {
    cJSON_Delete(room->history[room->next_message]);
    room->history[room->next_message] = message;
    room->next_message = (room->next_message + 1) % HISTORY_LIMIT;
    if (room->message_count < HISTORY_LIMIT) ++room->message_count;
    else if (room_store_enabled()) room->has_older = 1;
}

int rooms_storage_open(const char *path) {
    if (!room_store_open(path) || !room_store_expire(time(NULL)) || !room_store_restore(restore_member)) return 0;
    for (int r = 0; r < ROOM_LIMIT; ++r) {
        Room *room = &rooms[r];
        if (!room->used) continue;
        cJSON *messages = room_store_page(room->instance, 0, HISTORY_LIMIT, &room->has_older);
        if (!messages) return 0;
        while (messages->child) remember_message(room, cJSON_DetachItemFromArray(messages, 0));
        cJSON_Delete(messages);
    }
    return 1;
}

void rooms_storage_close(void) {
    room_store_close();
}

static void history_page(Client *client, Room *room, const char *before) {
    if (!room_store_enabled()) {
        send_error(client, "history_unavailable", "当前房间没有更早的记录");
        return;
    }
    unsigned long long cursor = before && *before && !before[strspn(before, "0123456789")]
                               ? strtoull(before, NULL, 10) : 0;
    if (!cursor || cursor > INT64_MAX) {
        send_error(client, "invalid_history", "历史记录位置无效");
        return;
    }
    int has_older;
    cJSON *messages = room_store_page(room->instance, (int64_t)cursor, HISTORY_PAGE, &has_older);
    if (!messages) {
        send_error(client, "history_read_failed", "暂时无法读取聊天记录");
        return;
    }
    cJSON *out = event("history");
    cJSON_AddItemToObject(out, "messages", messages);
    if (has_older) cJSON_AddStringToObject(out, "before", string_field(messages->child, "sequence"));
    send_json(client, out);
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
    unsigned start = (r->next_message + HISTORY_LIMIT - r->message_count) % HISTORY_LIMIT;
    if (r->has_older)
        cJSON_AddStringToObject(j, "history_before", string_field(r->history[start], "sequence"));
    send_json(c, j);
    /* 逐条回放，避免把 100 条记录塞进一个超长 WebSocket 帧。 */
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
    if (!strcmp(nickname, BOT_NAME)) { send_error(c,"invalid_nickname","此昵称保留给群聊助手"); return; }
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
    Room *room = &rooms[r];
    const char *default_name = "同行房间";
    time_t expires = time(NULL) + room_ttl;
    if (!(create ? room_store_create(instance, code, default_name, expires, nickname)
                 : room_store_add_member(room->instance, nickname))) {
        send_error(c, "room_storage_failed", "暂时无法保存房间信息");
        return;
    }
    if (create) {
        room->used = 1;
        strcpy(room->instance, instance);
        strcpy(room->code, code);
        strcpy(room->name, default_name);
        room->expires = expires;
    }
    Member *m = &members[free_member];
    m->used = 1; m->room = r; m->owner = create; m->connection = c;
    strcpy(m->nickname,nickname); strcpy(m->token,token); c->member = free_member;
    log_room_event(&rooms[r], create ? "create" : "join", nickname, NULL, NULL);
    joined(c,free_member);
}
static void broadcast_saved_event(int r, cJSON *out) {
    cJSON *saved = cJSON_Duplicate(out, 1);
    if (saved) remember_message(&rooms[r], saved);
    broadcast(r, out);
}
static int publish_event(int r, cJSON *out) {
    if (!out || !room_store_append(rooms[r].instance, out)) {
        cJSON_Delete(out);
        return 0;
    }
    broadcast_saved_event(r, out);
    return 1;
}
static int publish_message(Member *member, const char *type, const char *field, const char *value) {
    cJSON *out = event(type);
    if (!out || !cJSON_AddStringToObject(out, "nickname", member->nickname) ||
        !cJSON_AddStringToObject(out, field, value)) {
        cJSON_Delete(out);
        return 0;
    }
    if (!publish_event(member->room, out)) return 0;
    log_room_event(&rooms[member->room], type, member->nickname, field, value);
    return 1;
}
static int valid_sticker(const char *id) {
    return id && (!strcmp(id, "wave") || !strcmp(id, "ok") ||
                  !strcmp(id, "party") || !strcmp(id, "heart"));
}
/* Worker-only RPC. Secret is supplied from the environment, never from a browser.
   Every call resolves the original room membership token against live C state. */
static int internal_authorized(cJSON *j) {
    const char *secret = getenv("ASSISTANT_SHARED_SECRET");
    const char *given = string_field(j, "secret");
    return secret && strlen(secret) >= 32 && given && strlen(given) == strlen(secret) &&
           !CRYPTO_memcmp(secret, given, strlen(secret));
}
static Member *member_from_token(const char *token) {
    if (!token || strlen(token) != 64) return NULL;
    for (int i = 0; i < SESSION_LIMIT; ++i)
        if (members[i].used && !CRYPTO_memcmp(token, members[i].token, 64)) return &members[i];
    return NULL;
}
static int room_from_instance(const char *instance) {
    if (!instance) return -1;
    for (int r = 0; r < ROOM_LIMIT; ++r)
        if (rooms[r].used && !strcmp(rooms[r].instance, instance)) return r;
    return -1;
}
static void assistant_rpc(Client *c, cJSON *j) {
    if (!internal_authorized(j) || !string_field(j, "token")) {
        send_error(c,"forbidden","助手后台未授权"); return;
    }
    Member *m = member_from_token(string_field(j, "token"));
    if (!m) { send_error(c,"not_joined","房间成员会话已失效"); return; }
    Room *r=&rooms[m->room];
    const char *body=string_field(j,"text");
    if (body) {
        if (!m->owner || !valid_string(body,2048,0)) { send_error(c,"forbidden","只有房主可以发布有效行程"); return; }
        Member assistant=*m; strcpy(assistant.nickname,"行程助手");
        if (!publish_message(&assistant,"chat","text",body)) {
            send_error(c, "room_storage_failed", "暂时无法保存行程消息");
            return;
        }
    }
    cJSON *out=event("assistant_context");
    cJSON_AddStringToObject(out,"room",r->code);
    cJSON_AddStringToObject(out,"instance",r->instance);
    cJSON_AddStringToObject(out,"nickname",m->nickname);
    cJSON_AddBoolToObject(out,"owner",m->owner);
    cJSON_AddNumberToObject(out,"expires",(double)r->expires);
    cJSON *history=cJSON_AddArrayToObject(out,"history");
    unsigned start=(r->next_message+HISTORY_LIMIT-r->message_count)%HISTORY_LIMIT;
    for (unsigned k=0;k<r->message_count;k++) {
        cJSON *message = r->history[(start+k)%HISTORY_LIMIT];
        if (!string_field(message, "type") || strcmp(string_field(message, "type"), "notice"))
            cJSON_AddItemToArray(history,cJSON_Duplicate(message,1));
    }
    send_json(c,out);
}

static void bot_mention(Member *member, const char *text) {
    const char *mention = strstr(text, "@" BOT_NAME);
    size_t length = strlen("@" BOT_NAME);
    if (!mention) {
        mention = strstr(text, "＠" BOT_NAME);
        length = strlen("＠" BOT_NAME);
    }
    if (!mention) return;
    const char *after = mention + length;
    if (mention == text && !after[strspn(after, " \t\r\n")]) {
        send_error(member->connection, "bot_unavailable", "请在 @群聊助手 后输入问题");
        return;
    }
    time_t now = time(NULL);
    if (!bot_worker || bot_worker->dead || bot_worker->closing) {
        send_error(member->connection, "bot_unavailable", "群聊助手暂未连接");
        return;
    }
    Room *room = &rooms[member->room];
    BotRequest *request = NULL;
    for (int k = 0; k < BOT_PENDING_LIMIT; ++k)
        if (!room->bot_requests[k].deadline) { request = &room->bot_requests[k]; break; }
    if (now < member->next_bot_request || !request) {
        send_error(member->connection, "bot_unavailable", "群聊助手正在处理请求，请稍后再试");
        return;
    }
    if (!random_token(request->id)) {
        send_error(member->connection, "bot_unavailable", "群聊助手暂时无法接收请求");
        return;
    }
    strcpy(request->asker, member->token);
    request->deadline = now + 55;
    member->next_bot_request = now + 4;
    cJSON *out = event("bot_request");
    cJSON_AddStringToObject(out, "instance", room->instance);
    cJSON_AddStringToObject(out, "id", request->id);
    cJSON_AddStringToObject(out, "question", text);
    cJSON *history = cJSON_AddArrayToObject(out, "history");
    for (unsigned k = 1; k < room->message_count && cJSON_GetArraySize(history) < BOT_CONTEXT_LIMIT; ++k) {
        cJSON *message = room->history[(room->next_message + HISTORY_LIMIT - 1 - k) % HISTORY_LIMIT];
        const char *kind = string_field(message, "type");
        if (kind && !strcmp(kind, "chat")) cJSON_InsertItemInArray(history, 0, cJSON_Duplicate(message, 1));
    }
    send_json(bot_worker, out);
}

static void bot_reply(Client *c, cJSON *j) {
    if (c != bot_worker) { send_error(c, "forbidden", "助手后台未授权"); return; }
    const char *id = string_field(j, "id"), *text = string_field(j, "text");
    int r = room_from_instance(string_field(j, "instance"));
    if (r < 0 || !id) return;
    for (int k = 0; k < BOT_PENDING_LIMIT; ++k) {
        BotRequest *request = &rooms[r].bot_requests[k];
        if (!request->deadline || strcmp(request->id, id)) continue;
        if (!text || !valid_string(text, 2048, 0)) {
            bot_error(r, request->asker, "群聊助手暂时无法回答，请稍后重试");
        } else {
            cJSON *out = event("chat");
            cJSON_AddStringToObject(out, "nickname", BOT_NAME);
            cJSON_AddStringToObject(out, "text", text);
            cJSON_AddBoolToObject(out, "bot", 1);
            if (!publish_event(r, out)) bot_error(r, request->asker, "暂时无法保存群聊助手的回复");
        }
        memset(request, 0, sizeof *request);
        return;
    }
}

static void notice_identity(Client *c, cJSON *j, int room_required) {
    if (!internal_authorized(j)) { send_error(c, "forbidden", "通知后台未授权"); return; }
    const char *account = accounts_identity(string_field(j, "login"));
    if (!account) { send_error(c, "login_required", "请先登录账号"); return; }
    if (!room_required) {
        cJSON *out = event("account_context");
        cJSON_AddStringToObject(out, "account", account);
        send_json(c, out);
        return;
    }
    Member *owner = member_from_token(string_field(j, "token"));
    if (!owner || !owner->owner || strcmp(owner->nickname, account)) {
        send_error(c, "forbidden", "只有房主可以发布重要通知"); return;
    }
    Room *room = &rooms[owner->room];
    cJSON *out = event("notice_context");
    cJSON_AddStringToObject(out, "account", account);
    cJSON_AddStringToObject(out, "instance", room->instance);
    cJSON_AddStringToObject(out, "name", room->name);
    cJSON *recipients = cJSON_AddArrayToObject(out, "recipients");
    for (int i = 0; i < SESSION_LIMIT; ++i)
        if (members[i].used && members[i].room == owner->room)
            cJSON_AddItemToArray(recipients, cJSON_CreateString(members[i].nickname));
    send_json(c, out);
}

static void notice_card(Client *c, cJSON *j) {
    if (!internal_authorized(j)) { send_error(c, "forbidden", "通知后台未授权"); return; }
    int r = room_from_instance(string_field(j, "instance"));
    if (r < 0) { send_error(c, "room_not_found", "房间已关闭"); return; }
    const char *id = string_field(j, "id"), *title = string_field(j, "title");
    const char *text = string_field(j, "text"), *due = string_field(j, "due");
    const char *status = string_field(j, "status"), *version = string_field(j, "revision");
    if (!id || strlen(id) != 32 || strspn(id, "0123456789abcdef") != 32 ||
        !title || !valid_string(title, 240, 1) || !text || !valid_string(text, 2048, 0) ||
        !due || !valid_string(due, 32, 1) || !status ||
        (strcmp(status, "scheduled") && strcmp(status, "cancelled")) ||
        !version || !*version || strlen(version) > 8 || strspn(version, "0123456789") != strlen(version)) {
        send_error(c, "invalid_notice", "重要通知字段无效"); return;
    }
    unsigned revision = (unsigned)strtoul(version, NULL, 10);
    Room *room = &rooms[r];
    NoticeCard *card = NULL;
    for (int k = 0; k < NOTICE_LIMIT; ++k)
        if (!room->notices[k].id[0] || !strcmp(room->notices[k].id, id)) { card = &room->notices[k]; break; }
    if (!card) { send_error(c, "capacity", "房间通知已达到上限"); return; }
    if (revision > card->revision) {
        cJSON *out = event("notice");
        cJSON_AddStringToObject(out, "id", id);
        cJSON_AddStringToObject(out, "title", title);
        cJSON_AddStringToObject(out, "text", text);
        cJSON_AddStringToObject(out, "due", due);
        cJSON_AddStringToObject(out, "status", status);
        cJSON_AddNumberToObject(out, "revision", revision);
        int existing = card->id[0] != 0;
        int saved = room_store_enabled() ? room_store_notice(room->instance, id, revision, out, &existing) : 1;
        if (saved < 0) {
            cJSON_Delete(out);
            send_error(c, "room_storage_failed", "暂时无法保存重要通知");
            return;
        }
        if (!saved) {
            cJSON_Delete(out);
            send_json(c, event("notice_ack"));
            return;
        }
        if (!existing) broadcast_saved_event(r, out);
        else {
            for (unsigned k = 0; k < HISTORY_LIMIT; ++k) {
                const char *saved_id = string_field(room->history[k], "id");
                const char *kind = string_field(room->history[k], "type");
                if (kind && !strcmp(kind, "notice") && saved_id && !strcmp(saved_id, id)) {
                    cJSON_Delete(room->history[k]);
                    room->history[k] = cJSON_Duplicate(out, 1);
                    break;
                }
            }
            broadcast(r, out);
        }
        strcpy(card->id, id);
        card->revision = revision;
    }
    send_json(c, event("notice_ack"));
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
    } else if (!strcmp(type, "bot_watch")) {
        if (!internal_authorized(j) || member_of(c) >= 0 || c->account[0])
            send_error(c, "forbidden", "助手后台未授权");
        else if (bot_worker && bot_worker != c)
            send_error(c, "bot_busy", "群聊助手后台已连接");
        else {
            bot_worker = c;
            send_json(c, event("bot_ready"));
        }
    } else if (!strcmp(type, "bot_reply")) {
        bot_reply(c, j);
    } else if (!strcmp(type, "account_identity") || !strcmp(type, "notice_room")) {
        notice_identity(c, j, !strcmp(type, "notice_room"));
    } else if (!strcmp(type, "notice_card")) {
        notice_card(c, j);
    } else if (!strcmp(type, "auth_mode")) {
        cJSON *mode = event("auth_mode");
        cJSON_AddBoolToObject(mode, "required", accounts_active());
        const char *secret = getenv("ASSISTANT_SHARED_SECRET");
        cJSON_AddBoolToObject(mode, "assistant_enabled", secret && strlen(secret) >= 32);
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
    else if (!strcmp(type,"chat") || !strcmp(type,"leave") || !strcmp(type,"close") ||
             !strcmp(type,"rename") || !strcmp(type,"sticker") || !strcmp(type,"history")) {
        int i = member_of(c);
        if (i < 0) send_error(c,"not_joined","请先加入房间");
        else {
            int r = members[i].room;
            if (!strcmp(type,"chat")) {
                const char *body = string_field(j,"text");
                if (!body || !valid_string(body,2048,0)) send_error(c,"invalid_text","消息需要 1–2048 个合法 UTF-8 字节");
                else if (!publish_message(&members[i], "chat", "text", body))
                    send_error(c, "room_storage_failed", "消息未保存，请重试");
                else bot_mention(&members[i], body);
            } else if (!strcmp(type, "sticker")) {
                const char *id = string_field(j, "id");
                if (!valid_sticker(id)) send_error(c, "invalid_sticker", "没有这个贴图");
                else if (!publish_message(&members[i], "sticker", "id", id))
                    send_error(c, "room_storage_failed", "贴图未保存，请重试");
            } else if (!strcmp(type, "rename")) {
                const char *name = string_field(j, "name");
                if (!members[i].owner) send_error(c, "forbidden", "只有房主可以改名");
                else if (!name || !valid_string(name, 64, 1) || !name[strspn(name, " ")])
                    send_error(c, "invalid_name", "群名需要 1–64 个合法 UTF-8 字节");
                else if (!room_store_rename(rooms[r].instance, name))
                    send_error(c, "room_storage_failed", "暂时无法更改群名");
                else {
                    strcpy(rooms[r].name, name);
                    log_room_event(&rooms[r], "rename", members[i].nickname, "name", name);
                    cJSON *out = event("renamed");
                    cJSON_AddStringToObject(out, "name", name);
                    broadcast(r, out);
                }
            } else if (!strcmp(type,"history")) history_page(c, &rooms[r], string_field(j, "before"));
            else if (!strcmp(type,"close") && !members[i].owner) send_error(c,"forbidden","只有房主可以关闭房间");
            else if (members[i].owner) {
                if (room_store_remove(rooms[r].instance)) close_room(r,!strcmp(type,"leave") ? "owner_left" : "owner_closed");
                else send_error(c, "room_storage_failed", "暂时无法关闭房间，请重试");
            }
            else if (!room_store_remove_member(rooms[r].instance, members[i].nickname))
                send_error(c, "room_storage_failed", "暂时无法离开房间，请重试");
            else {
                log_room_event(&rooms[r], "leave", members[i].nickname, NULL, NULL);
                memset(&members[i],0,sizeof members[i]); c->member = -1;
                cJSON *out = event("closed"); cJSON_AddStringToObject(out,"reason","left"); send_json(c,out); online_list(r);
            }
        }
    } else send_error(c,"unknown_type","未知消息类型");
    cJSON_Delete(j);
}
