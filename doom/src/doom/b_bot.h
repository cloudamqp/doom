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
//     Lets a program play instead of the keyboard and mouse
//

#ifndef B_BOT_H
#define B_BOT_H

#include "d_ticcmd.h"

// Replaces the moves in cmd with the bot's, if one is playing
void B_BuildTiccmd(ticcmd_t *cmd, int maketic);

#endif /* #ifndef B_BOT_H */
