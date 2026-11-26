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
//     Lets a bot take on new code while it plays. With -botlib <file>,
//     the bot is the one in that library (build/native/bot.so), loaded
//     anew whenever the file changes. What a bot had in mind is gone with
//     the old code.
//

#include <dlfcn.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/stat.h>
#include <unistd.h>

#include "b_native.h"
#include "doomstat.h"
#include "i_timer.h"
#include "m_argv.h"
#include "m_misc.h"

#define CHECK_MS 1000

// When a file was last written, to the nanosecond
#ifdef __APPLE__
#define MTIME st_mtimespec
#else
#define MTIME st_mtim
#endif

// Loads the library and has its bot play from the next tic on. Returns
// false when it is no library yet, like a file that is still written.
static boolean Load(const char *path)
{
    char copy[] = "/tmp/doomq-botlib-XXXXXX";
    char command[1024];
    const bot_api_t *api;
    void *library;
    int fd = mkstemp(copy);

    // A library that is loaded stays as it was, whatever happens to its
    // file, and loading the same file again gives the same one: so every
    // build is loaded from a copy of its own
    if (fd < 0)
    {
        return false;
    }

    close(fd);
    M_snprintf(command, sizeof(command), "cp '%s' '%s'", path, copy);

    if (system(command) != 0)
    {
        unlink(copy);
        return false;
    }

    library = dlopen(copy, RTLD_NOW | RTLD_LOCAL);
    unlink(copy);
    api = library != NULL ? dlsym(library, "b_builtin") : NULL;

    if (api == NULL)
    {
        return false;
    }

    // The new bot reads the arguments, and the level if one is played.
    // The old code stays loaded: nothing calls it anymore.
    if (api->Active() && gamestate == GS_LEVEL && players[consoleplayer].mo != NULL)
    {
        api->LevelLoaded();
    }

    b_api = api;
    printf("bot: loaded %s\n", path);

    return true;
}

void Reload_Check(void)
{
    static const char *path;
    // The file that is loaded: a new build is another file of the same
    // name, or the same one written anew
    static ino_t loaded_file;
    static off_t loaded_size;
    static struct timespec loaded_time;
    static int checked_ms = -CHECK_MS;
    static boolean complained;
    struct stat file;

    if (path == NULL)
    {
        //!
        // @arg <file>
        // @category game
        //
        // Play with the bot of this library, and load it anew whenever
        // the file changes.
        //
        int i = M_CheckParmWithArgs("-botlib", 1);

        path = i > 0 ? myargv[i + 1] : "";
    }

    if (path[0] == '\0' || I_GetTimeMS() - checked_ms < CHECK_MS)
    {
        return;
    }

    checked_ms = I_GetTimeMS();

    if (stat(path, &file) != 0
     || (file.st_ino == loaded_file && file.st_size == loaded_size && file.MTIME.tv_sec == loaded_time.tv_sec
      && file.MTIME.tv_nsec == loaded_time.tv_nsec))
    {
        return;
    }

    if (Load(path))
    {
        loaded_file = file.st_ino;
        loaded_size = file.st_size;
        loaded_time = file.MTIME;
        complained = false;
    }
    else if (!complained)
    {
        // Tried again in a second: it may be half written
        printf("bot: could not load %s: %s\n", path, dlerror());
        complained = true;
    }
}
