// The few SDL names that the engine's portable files use, for native builds
// without SDL. The Wasm build uses the real SDL.

#ifndef NATIVE_SDL_H
#define NATIVE_SDL_H

#include <stdint.h>
#include <stdlib.h>
#include <string.h>

typedef uint32_t Uint32;

#define SDL_LIL_ENDIAN 1234
#define SDL_BIG_ENDIAN 4321

#if defined(__BYTE_ORDER__) && __BYTE_ORDER__ == __ORDER_BIG_ENDIAN__
#define SDL_BYTEORDER SDL_BIG_ENDIAN
#define SDL_SwapLE16(x) __builtin_bswap16(x)
#define SDL_SwapLE32(x) __builtin_bswap32(x)
#else
#define SDL_BYTEORDER SDL_LIL_ENDIAN
#define SDL_SwapLE16(x) (x)
#define SDL_SwapLE32(x) (x)
#endif

#define SDL_qsort qsort
#define SDL_free free

// Settings and saves go to the working directory
static inline char *SDL_GetPrefPath(const char *org, const char *app)
{
    return strdup("./");
}

#endif
