#ifndef PLATFORM_H
#define PLATFORM_H
#include "chat.h"
#ifdef _WIN32
#include <ws2tcpip.h>
#define BAD_SOCKET INVALID_SOCKET
#define close_socket closesocket
static inline int network_init(void) { WSADATA data; return WSAStartup(MAKEWORD(2,2), &data)==0; }
static inline void network_cleanup(void) { WSACleanup(); }
static inline int would_block(void) { int e=WSAGetLastError(); return e==WSAEWOULDBLOCK || e==WSAEINTR; }
static inline int nonblocking(socket_t fd) { u_long enabled=1; return ioctlsocket(fd,FIONBIO,&enabled)==0; }
#else
#include <sys/socket.h>
#include <sys/select.h>
#include <netinet/in.h>
#include <arpa/inet.h>
#include <unistd.h>
#include <fcntl.h>
#include <errno.h>
#define BAD_SOCKET (-1)
#define close_socket close
static inline int network_init(void) { return 1; }
static inline void network_cleanup(void) { }
static inline int would_block(void) { return errno==EAGAIN || errno==EWOULDBLOCK || errno==EINTR; }
static inline int nonblocking(socket_t fd) { int flags=fcntl(fd,F_GETFL,0); return flags>=0 && fcntl(fd,F_SETFL,flags|O_NONBLOCK)==0; }
#endif
#endif
