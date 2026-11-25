#include "room_store.h"
#include <inttypes.h>
#include <sqlite3.h>
#include <stdio.h>
#include <string.h>

static sqlite3 *store;

static int exec_sql(const char *sql) {
    return sqlite3_exec(store, sql, NULL, NULL, NULL) == SQLITE_OK;
}

int room_store_open(const char *path) {
    const char *schema =
        "PRAGMA foreign_keys=ON;"
        "PRAGMA secure_delete=ON;"
        "BEGIN IMMEDIATE;"
        "CREATE TABLE IF NOT EXISTS rooms("
        "instance TEXT PRIMARY KEY NOT NULL,code TEXT NOT NULL UNIQUE,name TEXT NOT NULL,expires INTEGER NOT NULL);"
        "CREATE TABLE IF NOT EXISTS members("
        "room TEXT NOT NULL REFERENCES rooms(instance) ON DELETE CASCADE,name TEXT NOT NULL,owner INTEGER NOT NULL,"
        "PRIMARY KEY(room,name));"
        "CREATE TABLE IF NOT EXISTS messages("
        "id INTEGER PRIMARY KEY,room TEXT NOT NULL REFERENCES rooms(instance) ON DELETE CASCADE,"
        "payload TEXT NOT NULL);"
        "CREATE INDEX IF NOT EXISTS room_messages ON messages(room,id);"
        "CREATE TABLE IF NOT EXISTS room_notice_messages("
        "room TEXT NOT NULL REFERENCES rooms(instance) ON DELETE CASCADE, notice TEXT NOT NULL,"
        "message INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE, revision INTEGER NOT NULL,"
        "PRIMARY KEY(room,notice));"
        "CREATE TABLE IF NOT EXISTS chat_deliveries("
        "room TEXT NOT NULL REFERENCES rooms(instance) ON DELETE CASCADE, sender TEXT NOT NULL, client_id TEXT NOT NULL,"
        "message INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE, PRIMARY KEY(room,sender,client_id));"
        "COMMIT;";
    if (sqlite3_open(path, &store) == SQLITE_OK && sqlite3_busy_timeout(store, 100) == SQLITE_OK &&
        exec_sql(schema)) return 1;
    if (store) { exec_sql("ROLLBACK"); sqlite3_close(store); store = NULL; }
    return 0;
}

void room_store_close(void) {
    if (store) sqlite3_close(store);
    store = NULL;
}

int room_store_enabled(void) {
    return store != NULL;
}

static sqlite3_stmt *prepare(const char *sql) {
    sqlite3_stmt *stmt = NULL;
    sqlite3_prepare_v2(store, sql, -1, &stmt, NULL);
    return stmt;
}

static int bind_text(sqlite3_stmt *stmt, int index, const char *value) {
    return sqlite3_bind_text(stmt, index, value, -1, SQLITE_TRANSIENT) == SQLITE_OK;
}

static const char *column(sqlite3_stmt *stmt, int index) {
    return (const char *)sqlite3_column_text(stmt, index);
}

static int write_text(const char *sql, const char *first, const char *second) {
    if (!store) return 1;
    sqlite3_stmt *stmt = prepare(sql);
    int ok = stmt && bind_text(stmt, 1, first) && (!second || bind_text(stmt, 2, second)) &&
             sqlite3_step(stmt) == SQLITE_DONE;
    sqlite3_finalize(stmt);
    return ok;
}

int room_store_expire(time_t now) {
    if (!store) return 1;
    sqlite3_stmt *stmt = prepare("DELETE FROM rooms WHERE expires<=?");
    int ok = stmt && sqlite3_bind_int64(stmt, 1, (sqlite3_int64)now) == SQLITE_OK &&
             sqlite3_step(stmt) == SQLITE_DONE;
    sqlite3_finalize(stmt);
    return ok;
}

int room_store_restore(int (*restore)(const char *, const char *, const char *, time_t, const char *, int)) {
    sqlite3_stmt *stmt = prepare(
        "SELECT r.instance,r.code,r.name,r.expires,m.name,m.owner "
        "FROM rooms r LEFT JOIN members m ON m.room=r.instance "
        "ORDER BY r.instance,m.owner DESC");
    if (!stmt) return 0;
    int result;
    while ((result = sqlite3_step(stmt)) == SQLITE_ROW) {
        if (!restore(column(stmt, 0), column(stmt, 1), column(stmt, 2),
                     (time_t)sqlite3_column_int64(stmt, 3), column(stmt, 4), sqlite3_column_int(stmt, 5))) break;
    }
    sqlite3_finalize(stmt);
    return result == SQLITE_DONE;
}

int room_store_create(const char *instance, const char *code, const char *name, time_t expires, const char *owner) {
    if (!store) return 1;
    if (!exec_sql("BEGIN IMMEDIATE")) return 0;
    sqlite3_stmt *stmt = prepare("INSERT INTO rooms(instance,code,name,expires) VALUES(?,?,?,?)");
    int ok = stmt && bind_text(stmt, 1, instance) && bind_text(stmt, 2, code) && bind_text(stmt, 3, name) &&
             sqlite3_bind_int64(stmt, 4, (sqlite3_int64)expires) == SQLITE_OK && sqlite3_step(stmt) == SQLITE_DONE;
    sqlite3_finalize(stmt);
    if (ok && write_text("INSERT INTO members(room,name,owner) VALUES(?,?,1)", instance, owner) &&
        exec_sql("COMMIT")) return 1;
    exec_sql("ROLLBACK");
    return 0;
}

int room_store_add_member(const char *instance, const char *name) {
    return write_text("INSERT INTO members(room,name,owner) VALUES(?,?,0)", instance, name);
}

int room_store_remove_member(const char *instance, const char *name) {
    return write_text("DELETE FROM members WHERE room=? AND name=?", instance, name);
}

int room_store_set_owner(const char *instance, const char *old_owner, const char *new_owner) {
    if (!store) return 1;
    if (!exec_sql("BEGIN IMMEDIATE")) return 0;
    sqlite3_stmt *s1 = prepare("UPDATE members SET owner=0 WHERE room=? AND name=?");
    int ok1 = s1 && bind_text(s1, 1, instance) && bind_text(s1, 2, old_owner) &&
              sqlite3_step(s1) == SQLITE_DONE;
    sqlite3_finalize(s1);
    sqlite3_stmt *s2 = ok1 ? prepare("UPDATE members SET owner=1 WHERE room=? AND name=?") : NULL;
    int ok2 = s2 && bind_text(s2, 1, instance) && bind_text(s2, 2, new_owner) &&
              sqlite3_step(s2) == SQLITE_DONE && sqlite3_changes(store) == 1;
    sqlite3_finalize(s2);
    if (ok1 && ok2 && exec_sql("COMMIT")) return 1;
    exec_sql("ROLLBACK");
    return 0;
}

int room_store_transfer_and_leave(const char *instance, const char *old_owner, const char *new_owner) {
    if (!store) return 1;
    if (!exec_sql("BEGIN IMMEDIATE")) return 0;
    sqlite3_stmt *s1 = prepare("UPDATE members SET owner=1 WHERE room=? AND name=?");
    int ok1 = s1 && bind_text(s1, 1, instance) && bind_text(s1, 2, new_owner) &&
              sqlite3_step(s1) == SQLITE_DONE && sqlite3_changes(store) == 1;
    sqlite3_finalize(s1);
    sqlite3_stmt *s2 = ok1 ? prepare("DELETE FROM members WHERE room=? AND name=?") : NULL;
    int ok2 = s2 && bind_text(s2, 1, instance) && bind_text(s2, 2, old_owner) &&
              sqlite3_step(s2) == SQLITE_DONE;
    sqlite3_finalize(s2);
    if (ok1 && ok2 && exec_sql("COMMIT")) return 1;
    exec_sql("ROLLBACK");
    return 0;
}

int room_store_rename(const char *instance, const char *name) {
    return write_text("UPDATE rooms SET name=?2 WHERE instance=?1", instance, name);
}

int room_store_extend(const char *instance, time_t expires) {
    if (!store) return 1;
    sqlite3_stmt *stmt = prepare("UPDATE rooms SET expires=?2 WHERE instance=?1");
    int ok = stmt && bind_text(stmt, 1, instance) &&
             sqlite3_bind_int64(stmt, 2, (sqlite3_int64)expires) == SQLITE_OK &&
             sqlite3_step(stmt) == SQLITE_DONE;
    sqlite3_finalize(stmt);
    return ok;
}

int room_store_remove(const char *instance) {
    return write_text("DELETE FROM rooms WHERE instance=?", instance, NULL);
}

static void add_sequence(cJSON *message, sqlite3_int64 id) {
    char text[32];
    snprintf(text, sizeof(text), "%" PRId64, (int64_t)id);
    cJSON_AddStringToObject(message, "sequence", text);
}

int room_store_append(const char *instance, cJSON *message) {
    if (!store) return 1;
    char *payload = cJSON_PrintUnformatted(message);
    int ok = payload && write_text("INSERT INTO messages(room,payload) VALUES(?,?)", instance, payload);
    cJSON_free(payload);
    if (ok) add_sequence(message, sqlite3_last_insert_rowid(store));
    return ok;
}

/* 消息和幂等键必须一起提交；重试读取原始服务端时间和序号。 */
int room_store_chat(const char *instance, const char *sender, const char *client_id, cJSON **message) {
    if (!exec_sql("BEGIN IMMEDIATE")) return 0;
    sqlite3_stmt *stmt = prepare("SELECT m.id,m.payload FROM chat_deliveries d JOIN messages m ON m.id=d.message "
                                "WHERE d.room=? AND d.sender=? AND d.client_id=?");
    int result = stmt && bind_text(stmt, 1, instance) && bind_text(stmt, 2, sender) &&
                 bind_text(stmt, 3, client_id) ? sqlite3_step(stmt) : SQLITE_ERROR;
    cJSON *saved = result == SQLITE_ROW ? cJSON_Parse(column(stmt, 1)) : NULL;
    if (saved) add_sequence(saved, sqlite3_column_int64(stmt, 0));
    sqlite3_finalize(stmt);
    if (result == SQLITE_ROW) {
        cJSON *old_text = cJSON_GetObjectItemCaseSensitive(saved, "text");
        cJSON *new_text = cJSON_GetObjectItemCaseSensitive(*message, "text");
        int same = cJSON_IsString(old_text) && cJSON_IsString(new_text) &&
                   !strcmp(old_text->valuestring, new_text->valuestring);
        int valid = cJSON_IsObject(saved);
        exec_sql("ROLLBACK");
        if (!valid || !same) { cJSON_Delete(saved); return valid ? -1 : 0; }
        cJSON_Delete(*message); *message = saved;
        return 2;
    }
    if (result != SQLITE_DONE || !room_store_append(instance, *message)) goto failed_chat;
    stmt = prepare("INSERT INTO chat_deliveries(room,sender,client_id,message) VALUES(?,?,?,?)");
    int ok = stmt && bind_text(stmt, 1, instance) && bind_text(stmt, 2, sender) &&
             bind_text(stmt, 3, client_id) && sqlite3_bind_int64(stmt, 4, sqlite3_last_insert_rowid(store)) == SQLITE_OK &&
             sqlite3_step(stmt) == SQLITE_DONE;
    sqlite3_finalize(stmt);
    if (ok && exec_sql("COMMIT")) return 1;
failed_chat:
    exec_sql("ROLLBACK");
    return 0;
}

/* 通知改期或撤销保留原来的消息位置，重启后也只显示最新版本。 */
int room_store_notice(const char *instance, const char *id, unsigned revision, cJSON *message, int *existing) {
    if (!exec_sql("BEGIN IMMEDIATE")) return -1;
    sqlite3_stmt *stmt = prepare("SELECT message,revision FROM room_notice_messages WHERE room=? AND notice=?");
    int result = stmt && bind_text(stmt, 1, instance) && bind_text(stmt, 2, id)
                 ? sqlite3_step(stmt) : SQLITE_ERROR;
    sqlite3_int64 sequence = result == SQLITE_ROW ? sqlite3_column_int64(stmt, 0) : 0;
    int previous = result == SQLITE_ROW ? sqlite3_column_int(stmt, 1) : 0;
    sqlite3_finalize(stmt);
    if (result != SQLITE_ROW && result != SQLITE_DONE) goto failed;
    *existing = result == SQLITE_ROW;
    if (*existing && revision <= (unsigned)previous) {
        return exec_sql("ROLLBACK") ? 0 : -1;
    }
    if (*existing) {
        char *payload = cJSON_PrintUnformatted(message);
        stmt = prepare("UPDATE messages SET payload=? WHERE id=?");
        int ok = stmt && payload && bind_text(stmt, 1, payload) &&
                 sqlite3_bind_int64(stmt, 2, sequence) == SQLITE_OK && sqlite3_step(stmt) == SQLITE_DONE;
        sqlite3_finalize(stmt);
        cJSON_free(payload);
        if (!ok) goto failed;
    } else {
        if (!room_store_append(instance, message)) goto failed;
        sequence = sqlite3_last_insert_rowid(store);
    }
    stmt = prepare("INSERT INTO room_notice_messages(room,notice,message,revision) VALUES(?,?,?,?) "
                   "ON CONFLICT(room,notice) DO UPDATE SET revision=excluded.revision");
    int ok = stmt && bind_text(stmt, 1, instance) && bind_text(stmt, 2, id) &&
             sqlite3_bind_int64(stmt, 3, sequence) == SQLITE_OK &&
             sqlite3_bind_int64(stmt, 4, revision) == SQLITE_OK && sqlite3_step(stmt) == SQLITE_DONE;
    sqlite3_finalize(stmt);
    if (!ok || !exec_sql("COMMIT")) goto failed;
    if (*existing) add_sequence(message, sequence);
    return 1;

failed:
    exec_sql("ROLLBACK");
    return -1;
}

cJSON *room_store_page(const char *instance, int64_t before, unsigned limit, int *has_older) {
    *has_older = 0;
    sqlite3_stmt *stmt = prepare(before
        ? "SELECT id,payload FROM messages WHERE room=?1 AND id<?3 ORDER BY id DESC LIMIT ?2"
        : "SELECT id,payload FROM messages WHERE room=?1 ORDER BY id DESC LIMIT ?2");
    cJSON *messages = cJSON_CreateArray();
    if (!stmt || !messages || !bind_text(stmt, 1, instance) ||
        sqlite3_bind_int(stmt, 2, (int)limit + 1) != SQLITE_OK ||
        (before && sqlite3_bind_int64(stmt, 3, (sqlite3_int64)before) != SQLITE_OK)) goto error;
    int result;
    unsigned count = 0;
    while ((result = sqlite3_step(stmt)) == SQLITE_ROW) {
        if (count == limit) {
            *has_older = 1;
            break;
        }
        const char *payload = column(stmt, 1);
        cJSON *message = payload ? cJSON_Parse(payload) : NULL;
        if (!cJSON_IsObject(message)) {
            cJSON_Delete(message);
            goto error;
        }
        add_sequence(message, sqlite3_column_int64(stmt, 0));
        if (!cJSON_InsertItemInArray(messages, 0, message)) {
            cJSON_Delete(message);
            goto error;
        }
        ++count;
    }
    if (result != SQLITE_DONE && !*has_older) goto error;
    sqlite3_finalize(stmt);
    return messages;

error:
    sqlite3_finalize(stmt);
    cJSON_Delete(messages);
    return NULL;
}
