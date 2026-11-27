#include "accounts.h"
#include <openssl/crypto.h>
#include <openssl/rand.h>
#include <openssl/sha.h>
#include <sqlite3.h>
#include <stdio.h>
#include <string.h>

#define PASSWORD_ROUNDS 600000
#define LOGIN_LIMIT 256
#define LOGIN_TTL 43200
#define CODE_ATTEMPTS 5
#define ACCOUNT_NAME_SQL "CREATE TABLE IF NOT EXISTS accounts(name TEXT PRIMARY KEY, salt BLOB NOT NULL, hash BLOB NOT NULL);"


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
static int migrate_accounts(void);

int accounts_open(const char *path) {
    if (sqlite3_open(path, &db) == SQLITE_OK) {
        sqlite3_busy_timeout(db, 500);
        if (execute(ACCOUNT_NAME_SQL) && migrate_accounts()) return 1;
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

static int column_exists(const char *table, const char *column) {
    char sql[64];
    sqlite3_stmt *stmt = NULL;
    int found = 0;
    snprintf(sql, sizeof sql, "PRAGMA table_info(%s)", table);
    if (sqlite3_prepare_v2(db, sql, -1, &stmt, NULL) != SQLITE_OK) return 0;
    while (sqlite3_step(stmt) == SQLITE_ROW) {
        const char *name = (const char *)sqlite3_column_text(stmt, 1);
        if (name && !strcmp(name, column)) found = 1;
    }
    sqlite3_finalize(stmt);
    return found;
}
static int migrate_accounts(void) {
    if (!column_exists("accounts", "email") && !execute("ALTER TABLE accounts ADD COLUMN email TEXT")) return 0;
    return execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS accounts_email_unique ON accounts(email) WHERE email IS NOT NULL;"
        "CREATE TABLE IF NOT EXISTS login_challenges("
        "key BLOB PRIMARY KEY, proof BLOB NOT NULL, email TEXT NOT NULL, expires INTEGER NOT NULL, "
        "attempts INTEGER NOT NULL DEFAULT 0);"
        "CREATE INDEX IF NOT EXISTS login_challenges_expiry ON login_challenges(expires);"
        "CREATE TABLE IF NOT EXISTS login_limits("
        "bucket TEXT PRIMARY KEY, hits INTEGER NOT NULL, window_start INTEGER NOT NULL);");
}

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

static int check_password(const char *name, const char *password) {
    unsigned char salt[16] = {0}, hash[32], expected[32] = {0};
    sqlite3_stmt *stmt = prepare("SELECT salt,hash FROM accounts WHERE name=? AND email IS NULL");
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
static const char *resolve_email_account(const char *email, const char *legacy_name,
                                         const char *legacy_password, char name[25]) {
    sqlite3_stmt *stmt = prepare("SELECT name FROM accounts WHERE email=?");
    int result = stmt && bind_text(stmt, 1, email) ? sqlite3_step(stmt) : SQLITE_ERROR;
    if (result == SQLITE_ROW) {
        const char *stored = (const char *)sqlite3_column_text(stmt, 0);
        if (!username_valid(stored)) result = SQLITE_ERROR;
        else strcpy(name, stored);
    }
    sqlite3_finalize(stmt);
    if (result == SQLITE_ROW) return legacy_name ? "email_taken" : NULL;
    if (result != SQLITE_DONE) return "account_storage";

    if (legacy_name) {
        if (!check_password(legacy_name, legacy_password)) return "migration_invalid";
        stmt = prepare("UPDATE accounts SET email=? WHERE name=? AND email IS NULL");
        strcpy(name, legacy_name);
    } else {
        strcpy(name, "user_");
        if (!random_hex(name + 5, 8)) return "account_storage";
        stmt = prepare("INSERT INTO accounts(email,name,salt,hash) VALUES (?,?,X'',X'')");
    }
    int saved = stmt && bind_text(stmt, 1, email) && bind_text(stmt, 2, name) &&
                sqlite3_step(stmt) == SQLITE_DONE && sqlite3_changes(db) == 1;
    sqlite3_finalize(stmt);
    return saved ? NULL : "account_storage";
}

static const char *verify_email_code(const char *challenge, const char *code,
                                     const char *legacy_name, const char *legacy_password,
                                     char name[25]) {
    if (!challenge || strlen(challenge) != 64 || strspn(challenge, "0123456789abcdef") != 64 ||
        !code || strlen(code) != 6 || strspn(code, "0123456789") != 6)
        return "code_invalid";
    if ((legacy_name || legacy_password) &&
        (!username_valid(legacy_name) || !legacy_password ||
         strlen(legacy_password) < 8 || strlen(legacy_password) > 128))
        return "migration_invalid";

    char input[72], email[255];
    snprintf(input, sizeof input, "%s:%s", challenge, code);
    unsigned char key[SHA256_DIGEST_LENGTH], proof[SHA256_DIGEST_LENGTH];
    SHA256((const unsigned char *)challenge, 64, key);
    SHA256((const unsigned char *)input, strlen(input), proof);
    OPENSSL_cleanse(input, sizeof input);
    if (!execute("BEGIN IMMEDIATE")) return "account_storage";

    sqlite3_stmt *stmt = prepare(
        "SELECT proof,email FROM login_challenges WHERE key=? AND expires>? AND attempts<?");
    int result = stmt && sqlite3_bind_blob(stmt, 1, key, sizeof key, SQLITE_STATIC) == SQLITE_OK &&
                 sqlite3_bind_int64(stmt, 2, (sqlite3_int64)time(NULL)) == SQLITE_OK &&
                 sqlite3_bind_int(stmt, 3, CODE_ATTEMPTS) == SQLITE_OK ? sqlite3_step(stmt) : SQLITE_ERROR;
    int matches = 0;
    if (result == SQLITE_ROW) {
        const char *address = (const char *)sqlite3_column_text(stmt, 1);
        if (!address || strlen(address) >= sizeof email ||
            sqlite3_column_bytes(stmt, 0) != sizeof proof) result = SQLITE_ERROR;
        else {
            strcpy(email, address);
            matches = CRYPTO_memcmp(sqlite3_column_blob(stmt, 0), proof, sizeof proof) == 0;
        }
    }
    sqlite3_finalize(stmt);
    OPENSSL_cleanse(proof, sizeof proof);
    if (result != SQLITE_ROW) {
        execute("ROLLBACK");
        return result == SQLITE_DONE ? "code_invalid" : "account_storage";
    }

    const char *error = matches ? resolve_email_account(email, legacy_name, legacy_password, name) : "code_invalid";
    if (error && !strcmp(error, "account_storage")) {
        execute("ROLLBACK");
        return error;
    }
    stmt = prepare(error ? "UPDATE login_challenges SET attempts=attempts+1 WHERE key=?"
                         : "DELETE FROM login_challenges WHERE key=?");
    int changed = stmt && sqlite3_bind_blob(stmt, 1, key, sizeof key, SQLITE_STATIC) == SQLITE_OK &&
                  sqlite3_step(stmt) == SQLITE_DONE && sqlite3_changes(db) == 1;
    sqlite3_finalize(stmt);
    if (changed && execute("COMMIT")) return error;
    execute("ROLLBACK");
    return "account_storage";
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
    if (!strcmp(error, "code_invalid")) return "验证码有误、已过期或已使用，请核对或重新发送";
    if (!strcmp(error, "email_taken")) return "该邮箱已关联一个账号，请使用其他邮箱迁移";
    if (!strcmp(error, "migration_invalid")) return "旧账号凭据有误，或该账号已经绑定登录邮箱";
    return "账号存储暂时不可用";
}
/* 登录校验失败也保留消息标识，前端才能停止等待并提供重试。 */
static void access_error(Client *client, const cJSON *message, const char *type,
                         const char *code, const char *description) {
    const char *id = !strcmp(type, "chat") ? field(message, "client_id") : NULL;
    if (!id) { send_error(client, code, description); return; }
    cJSON *out = cJSON_CreateObject();
    cJSON_AddStringToObject(out, "type", "error");
    cJSON_AddStringToObject(out, "code", code);
    cJSON_AddStringToObject(out, "message", description);
    cJSON_AddStringToObject(out, "client_id", id);
    send_json(client, out);
}

int accounts_handle(Client *client, const cJSON *message, const char *type) {
    if (!accounts_active() || !strcmp(type, "ping")) return 0;
    int credentials = !strcmp(type, "email_login");
    int resume = !strcmp(type, "authenticate");
    int logout = !strcmp(type, "logout");
    if (!client->ssl) {
        access_error(client, message, type, "tls_required", "请通过 HTTPS 打开聊天室");
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
        time_t now = time(NULL);
        if (now != attempt_window) { attempt_window = now; attempts = 0; }
        if (attempts >= 4 || now < client->next_auth_attempt) {
            send_error(client, "auth_busy", "请稍后重试");
            return 1;
        }
        ++attempts; client->next_auth_attempt = now + 1;
        char name[25];
        const char *error = verify_email_code(field(message, "challenge"), field(message, "code"),
                                              field(message, "legacy_name"), field(message, "legacy_password"), name);
        if (error) { send_error(client, error, error_text(error)); return 1; }
        issue_login(client, name);
        return 1;
    }
    if (!client->account[0] || !find_login(client->login_token)) {
        room_disconnect(client);
        client->account[0] = client->login_token[0] = 0;
        access_error(client, message, type, "login_required", "请先登录");
        return 1;
    }
    return 0;
}
