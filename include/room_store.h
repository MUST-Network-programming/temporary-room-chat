#ifndef ROOM_STORE_H
#define ROOM_STORE_H

#include "chat.h"

int room_store_open(const char *path);
void room_store_close(void);
int room_store_enabled(void);
int room_store_expire(time_t now);
int room_store_restore(int (*restore)(const char *, const char *, const char *, time_t, const char *, int));
int room_store_create(const char *instance, const char *code, const char *name, time_t expires, const char *owner);
int room_store_add_member(const char *instance, const char *name);
int room_store_remove_member(const char *instance, const char *name);
int room_store_set_owner(const char *instance, const char *old_owner, const char *new_owner);
int room_store_transfer_and_leave(const char *instance, const char *old_owner, const char *new_owner);
int room_store_rename(const char *instance, const char *name);
int room_store_extend(const char *instance, time_t expires);
int room_store_remove(const char *instance);
int room_store_append(const char *instance, cJSON *message);
/* 1 new, 2 identical retry, -1 conflicting text, 0 storage failure. */
int room_store_chat(const char *instance, const char *sender, const char *client_id, cJSON **message);
int room_store_notice(const char *instance, const char *id, unsigned revision, cJSON *message, int *existing);
cJSON *room_store_page(const char *instance, int64_t before, unsigned limit, int *has_older);

#endif
