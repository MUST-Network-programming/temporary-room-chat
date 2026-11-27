#ifndef ACCOUNTS_H
#define ACCOUNTS_H
#include "chat.h"
int accounts_open(const char *path);
void accounts_close(void);
int accounts_active(void);
const char *accounts_identity(const char *token);
int accounts_handle(Client *client, const cJSON *message, const char *type);
#endif
