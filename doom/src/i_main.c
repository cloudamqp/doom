//
// Copyright(C) 1993-1996 Id Software, Inc.
// Copyright(C) 2005-2014 Simon Howard
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
//	Main program, simply calls D_DoomMain high level loop.
//

#include "config.h"

#include <stdio.h>
#include <stdlib.h>

#include "SDL.h"

#include "doomtype.h"
#include "i_system.h"
#include "m_argv.h"

//
// D_DoomMain()
// Not a globally visible function, just included for source reference,
// calls all startup code, parses command line options.
//

void D_DoomMain (void);

// In doom/native/lobby.c
void Lobby_Run(void);

int main(int argc, char **argv)
{
    // save arguments

    myargc = argc;
    myargv = argv;

#ifndef __EMSCRIPTEN__
    // Whoever runs this follows the "doom: <code>, <text>" lines on stdout,
    // also when it is a pipe or a file
    setvbuf(stdout, NULL, _IOLBF, 0);
#endif

    //!
    // Print the program version and exit.
    //
    if (M_ParmExists("-version") || M_ParmExists("--version")) {
        puts(PACKAGE_STRING);
        exit(0);
    }

#if defined(_WIN32)
    // compose a proper command line from loose file paths passed as arguments
    // to allow for loading WADs and DEHACKED patches by drag-and-drop
    M_AddLooseFiles();
#endif

    M_FindResponseFile();
    M_SetExeDir();

    #ifdef SDL_HINT_NO_SIGNAL_HANDLERS
    SDL_SetHint(SDL_HINT_NO_SIGNAL_HANDLERS, "1");
    #endif

#ifndef __EMSCRIPTEN__
    //!
    // @category net
    //
    // Send bots into the games of the lobby that ask for them.
    //
    if (M_ParmExists("-lobby")) {
        Lobby_Run();
    }
#endif

    // start doom

    D_DoomMain ();

    return 0;
}

