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
//     TLS for the connection to the broker, see tls.h.
//

#include <openssl/err.h>
#include <openssl/ssl.h>
#include <openssl/x509_vfy.h>

#include "m_misc.h"
#include "tls.h"

static SSL_CTX *context;
static SSL *tls;

// OpenSSL 4 has a call of its own for host names and deprecates the one
// that also took addresses
static int ExpectHost(SSL *ssl, const char *host)
{
#if OPENSSL_VERSION_MAJOR >= 4
    return SSL_set1_dnsname(ssl, host);
#else
    return SSL_set1_host(ssl, host);
#endif
}

boolean TLS_Start(int sock, const char *host, char *error, size_t error_size)
{
    context = SSL_CTX_new(TLS_client_method());

    if (context == NULL || !SSL_CTX_set_default_verify_paths(context))
    {
        M_snprintf(error, error_size, "TLS: no certificates to trust");
        return false;
    }

    SSL_CTX_set_verify(context, SSL_VERIFY_PEER, NULL);
    tls = SSL_new(context);

    // The certificate must be for this host, which is told to the server
    // too: it may serve several
    if (tls == NULL || !SSL_set_fd(tls, sock) || !SSL_set_tlsext_host_name(tls, host) || !ExpectHost(tls, host))
    {
        M_snprintf(error, error_size, "TLS: could not set up");
        return false;
    }

    if (SSL_connect(tls) != 1)
    {
        long verified = SSL_get_verify_result(tls);

        if (verified != X509_V_OK)
        {
            M_snprintf(error, error_size, "TLS: certificate of %s: %s", host, X509_verify_cert_error_string(verified));
        }
        else
        {
            M_snprintf(error, error_size, "TLS: %s", ERR_reason_error_string(ERR_peek_last_error()));
        }

        return false;
    }

    return true;
}

ssize_t TLS_Read(void *data, size_t size)
{
    return SSL_read(tls, data, size);
}

ssize_t TLS_Write(const void *data, size_t size)
{
    return SSL_write(tls, data, size);
}

boolean TLS_Pending(void)
{
    return SSL_pending(tls) > 0;
}

void TLS_Stop(void)
{
    SSL_free(tls);
    SSL_CTX_free(context);
    tls = NULL;
    context = NULL;
}
