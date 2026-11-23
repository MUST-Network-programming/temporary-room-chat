#include "accounts.h"
#include <openssl/crypto.h>
#include <openssl/rand.h>
#include <sqlite3.h>
#include <stdio.h>
#include <string.h>

#define PASSWORD_ROUNDS 600000
#define LOGIN_LIMIT 256
#define LOGIN_TTL 43200
#define ACCOUNT_NAME_SQL "CREATE TABLE IF NOT EXISTS accounts(name TEXT PRIMARY KEY, salt BLOB NOT NULL, hash BLOB NOT NULL);"
#define INVITE_SQL "CREATE TABLE IF NOT EXISTS invites(code TEXT PRIMARY KEY, used INTEGER NOT NULL DEFAULT 0);"

typedef struct {
    char token[65], name[25];
    time_t expires;
} Login;

static sqlite3 *db;
static Login logins[LOGIN_LIMIT];
static time_t attempt_window;
static unsigned attempts;

static int execute(const char *sql) {
    return sqlite3_exec(db, sql, NULL, NULL, NULL) == SQLITE_OK;
}

int accounts_open(const char *path) {
    if (sqlite3_open(path, &db) == SQLITE_OK) {
        sqlite3_busy_timeout(db, 500);
        if (execute(ACCOUNT_NAME_SQL INVITE_SQL)) return 1;
    }
    fprintf(stderr, "Could not open account database\n");
    accounts_close();
    return 0;
}
void accounts_close(void) {
    if (db) sqlite3_close(db);
    db = NULL;
    OPENSSL_cleanse(logins, sizeof logins);
}
int accounts_active(void) { return db != NULL; }

static int random_hex(char *out, int count) {
    static const char hex[] = "0123456789abcdef";
    unsigned char data[32];
    if (count > (int)sizeof data || RAND_bytes(data, count) != 1) return 0;
    for (int i = 0; i < count; ++i) {
        out[2*i] = hex[data[i] >> 4];
        out[2*i+1] = hex[data[i] & 15];
    }
    out[2*count] = 0;
    return 1;
}
static sqlite3_stmt *prepare(const char *sql) {
    sqlite3_stmt *statement = NULL;
    sqlite3_prepare_v2(db, sql, -1, &statement, NULL);
    return statement;
}
static int bind_text(sqlite3_stmt *stmt, int index, const char *text) {
    return sqlite3_bind_text(stmt, index, text, -1, SQLITE_TRANSIENT) == SQLITE_OK;
}
int accounts_invite(void) {
    char code[33];
    if (!random_hex(code, 16)) return 0;
    sqlite3_stmt *stmt = prepare("INSERT INTO invites(code) VALUES (?)");
    int success = stmt && bind_text(stmt, 1, code) && sqlite3_step(stmt) == SQLITE_DONE;
    sqlite3_finalize(stmt);
    if (success) puts(code);
    return success;
}

static const char *field(const cJSON *message, const char *name) {
    const cJSON *item = cJSON_GetObjectItemCaseSensitive(message, name);
    return cJSON_IsString(item) ? item->valuestring : NULL;
}
static int username_valid(const char *name) {
    if (!name || strlen(name) < 3 || strlen(name) > 24) return 0;
    return name[strspn(name, "abcdefghijklmnopqrstuvwxyz0123456789_")] == 0;
}
static int password_hash(const char *password, const unsigned char salt[16], unsigned char hash[32]) {
    return PKCS5_PBKDF2_HMAC(password, (int)strlen(password), salt, 16, PASSWORD_ROUNDS,
                            EVP_sha256(), 32, hash) == 1;
}

static const char *register_account(const char *name, const char *password, const char *invite) {
    if (!invite || strlen(invite) != 32 || invite[strspn(invite, "0123456789abcdef")])
        return "invite_invalid";
    unsigned char salt[16], hash[32];
    if (RAND_bytes(salt, sizeof salt) != 1 || !password_hash(password, salt, hash))
        return "account_storage";
    if (!execute("BEGIN IMMEDIATE")) return "account_storage";
    /* 账号与邀请码在同一个事务提交，重复请求不能得到第二个账号。 */
    const char *error = "account_storage";
    sqlite3_stmt *stmt = prepare("UPDATE invites SET used=1 WHERE code=? AND used=0");
    if (stmt && bind_text(stmt, 1, invite) && sqlite3_step(stmt) == SQLITE_DONE) {
        error = sqlite3_changes(db) == 1 ? NULL : "invite_invalid";
    }
    sqlite3_finalize(stmt);
    if (!error) {
        stmt = prepare("INSERT INTO accounts(name,salt,hash) VALUES (?,?,?)");
        int result = SQLITE_ERROR;
        if (stmt && bind_text(stmt, 1, name) &&
            sqlite3_bind_blob(stmt, 2, salt, sizeof salt, SQLITE_TRANSIENT) == SQLITE_OK &&
            sqlite3_bind_blob(stmt, 3, hash, sizeof hash, SQLITE_TRANSIENT) == SQLITE_OK)
            result = sqlite3_step(stmt);
        sqlite3_finalize(stmt);
        if (result != SQLITE_DONE)
            error = result == SQLITE_CONSTRAINT ? "name_taken" : "account_storage";
    }
    OPENSSL_cleanse(hash, sizeof hash);
    if (!error && execute("COMMIT")) return NULL;
    execute("ROLLBACK");
    return error ? error : "account_storage";
}
static int check_password(const char *name, const char *password) {
    unsigned char salt[16] = {0}, hash[32], expected[32] = {0};
    sqlite3_stmt *stmt = prepare("SELECT salt,hash FROM accounts WHERE name=?");
    int found = stmt && bind_text(stmt, 1, name) && sqlite3_step(stmt) == SQLITE_ROW &&
                sqlite3_column_bytes(stmt, 0) == 16 && sqlite3_column_bytes(stmt, 1) == 32;
    if (found) {
        memcpy(salt, sqlite3_column_blob(stmt, 0), sizeof salt);
        memcpy(expected, sqlite3_column_blob(stmt, 1), sizeof expected);
    }
    sqlite3_finalize(stmt);
    int success = password_hash(password, salt, hash) &&
                  CRYPTO_memcmp(hash, expected, sizeof hash) == 0 && found;
    OPENSSL_cleanse(hash, sizeof hash);
    return success;
}
static Login *find_login(const char *token) {
    if (!token || strlen(token) != 64) return NULL;
    time_t now = time(NULL);
    for (int i = 0; i < LOGIN_LIMIT; ++i)
        if (logins[i].expires > now && CRYPTO_memcmp(logins[i].token, token, 64) == 0)
            return &logins[i];
    return NULL;
}
static void authenticated(Client *client, Login *login) {
    strcpy(client->account, login->name);
    strcpy(client->login_token, login->token);
    cJSON *reply = cJSON_CreateObject();
    cJSON_AddStringToObject(reply, "type", "authenticated");
    cJSON_AddStringToObject(reply, "name", login->name);
    cJSON_AddStringToObject(reply, "token", login->token);
    send_json(client, reply);
}
const char *accounts_identity(const char *token) {
    Login *login = accounts_active() && token ? find_login(token) : NULL;
    return login ? login->name : NULL;
}
static void issue_login(Client *client, const char *name) {
    Login *available = &logins[0];
    for (int i = 1; i < LOGIN_LIMIT; ++i)
        if (logins[i].expires < available->expires) available = &logins[i];
    if (!random_hex(available->token, 32)) {
        send_error(client, "account_storage", "无法创建登录会话");
        return;
    }
    strcpy(available->name, name);
    available->expires = time(NULL) + LOGIN_TTL;
    authenticated(client, available);
}
static const char *error_text(const char *error) {
    if (!strcmp(error, "invite_invalid")) return "注册码无效或已使用";
    if (!strcmp(error, "name_taken")) return "用户名已注册";
    return "账号存储暂时不可用";
}
int accounts_handle(Client *client, const cJSON *message, const char *type) {
    if (!accounts_active() || !strcmp(type, "ping")) return 0;
    int registration = !strcmp(type, "register");
    int credentials = registration || !strcmp(type, "login");
    int resume = !strcmp(type, "authenticate");
    int logout = !strcmp(type, "logout");
    if (!client->ssl) {
        send_error(client, "tls_required", "请通过 HTTPS 打开聊天室");
        return 1;
    }
    if (logout) {
        Login *login = find_login(client->login_token);
        if (login) OPENSSL_cleanse(login, sizeof *login);
        room_disconnect(client);
        client->account[0] = client->login_token[0] = 0;
        return 1;
    }
    if (credentials || resume) {
        if (client->account[0]) {
            send_error(client, "already_authenticated", "请先退出当前账号");
            return 1;
        }
        if (resume) {
            Login *login = find_login(field(message, "token"));
            if (login) authenticated(client, login);
            else send_error(client, "login_expired", "登录已失效，请重新登录");
            return 1;
        }
        const char *name = field(message, "name"), *password = field(message, "password");
        if (!username_valid(name) || !password || strlen(password) < 8 || strlen(password) > 128) {
            send_error(client, "invalid_credentials", "用户名为 3–24 位小写字母、数字或下划线，密码至少 8 个字节");
            return 1;
        }
        time_t now = time(NULL);
        if (now != attempt_window) { attempt_window = now; attempts = 0; }
        if (attempts >= 4 || now < client->next_auth_attempt) {
            send_error(client, "auth_busy", "请稍后重试");
            return 1;
        }
        ++attempts; client->next_auth_attempt = now + 1;
        if (registration) {
            const char *error = register_account(name, password, field(message, "invite"));
            if (error) { send_error(client, error, error_text(error)); return 1; }
        } else if (!check_password(name, password)) {
            send_error(client, "login_invalid", "用户名或密码错误");
            return 1;
        }
        issue_login(client, name);
        return 1;
    }
    if (!client->account[0] || !find_login(client->login_token)) {
        room_disconnect(client);
        client->account[0] = client->login_token[0] = 0;
        send_error(client, "login_required", "请先登录");
        return 1;
    }
    return 0;
}
