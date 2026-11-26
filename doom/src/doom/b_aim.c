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
//     How a bot aims, see b_aim.h.
//

#include "b_aim.h"

short B_TurnToward(angle_t from, angle_t to, int max_turn)
{
    // Angles wrap around at 32 bits, so their difference as a signed
    // number is the short way round. A ticcmd has its upper 16 bits.
    int turn = (int32_t) (to - from) / 65536;

    if (turn > max_turn)
    {
        return max_turn;
    }

    if (turn < -max_turn)
    {
        return -max_turn;
    }

    return turn;
}
