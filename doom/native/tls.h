//
// Copyright(C) 2026 84codes AB
//
// This program is free software; you can redistribute it and/or
// modify it under the terms of the GNU General Public License
// as published by the Free Software Foundation; either version 2
// of the License, or (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU General Public License for more details.
//
// DESCRIPTION:
//     TLS for the connection to the broker, with OpenSSL. The broker has
//     to show a certificate for its host name that the system trusts,
//     there is no way around that.
//

#ifndef NATIVE_TLS_H
#define NATIVE_TLS_H

#include <stddef.h>
#include <sys/types.h>

#include "doomtype.h"

// Starts TLS on a connected socket. On failure, error says why.
boolean TLS_Start(int sock, const char *host, char *error, size_t error_size);

// Like read() and write() on the socket
ssize_t TLS_Read(void *data, size_t size);
ssize_t TLS_Write(const void *data, size_t size);

// Whether TLS_Read has data without the socket having more to read
boolean TLS_Pending(void);

void TLS_Stop(void);

#endif
