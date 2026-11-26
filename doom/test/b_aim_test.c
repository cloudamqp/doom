// Unit tests of the bot's aiming, run with: make test

#include <assert.h>
#include <stdio.h>

#include "b_aim.h"

static void TurnsTheShortWay(void)
{
    // A ticcmd turns in units of 1/65536 of a circle, left is positive
    assert(B_TurnToward(0, ANG90, 20000) == 16384);
    assert(B_TurnToward(ANG90, 0, 20000) == -16384);
    // From 350 to 10 degrees is 20 degrees left, across north
    assert(B_TurnToward((angle_t) ANG1 * 350, (angle_t) ANG1 * 10, 20000) > 0);
    assert(B_TurnToward((angle_t) ANG1 * 10, (angle_t) ANG1 * 350, 20000) < 0);
}

static void TurnsNoFasterThanAllowed(void)
{
    assert(B_TurnToward(0, ANG90, 1000) == 1000);
    assert(B_TurnToward(0, ANG270, 1000) == -1000);
    assert(B_TurnToward(ANG45, ANG45, 1000) == 0);
}

int main(void)
{
    TurnsTheShortWay();
    TurnsNoFasterThanAllowed();
    puts("b_aim: ok");
    return 0;
}
