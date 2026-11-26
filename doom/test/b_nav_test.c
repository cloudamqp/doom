// Unit tests of the bot's route finding, run with: make test

#include <assert.h>
#include <stdio.h>

#include "b_nav.h"

static const nav_point_t door01 = {100, 50}, door12 = {200, 50};

// Three rooms of 100 by 100 in a row, 0 | 1 | 2, with a door in the
// middle of each wall between them
static void ThreeRooms(void)
{
    B_NavReset(3);
    B_NavConnect(0, 1, door01);
    B_NavConnect(1, 0, door01);
    B_NavConnect(1, 2, door12);
    B_NavConnect(2, 1, door12);
}

static void WalksStraightWithinAnArea(void)
{
    nav_point_t path[8];

    ThreeRooms();

    assert(B_NavPath((nav_point_t){10, 10}, 0, (nav_point_t){90, 90}, 0, path, 8) == 1);
    assert(path[0].x == 90 && path[0].y == 90);
}

static void CrossesWhereAreasConnect(void)
{
    nav_point_t path[8];

    ThreeRooms();

    assert(B_NavPath((nav_point_t){10, 10}, 0, (nav_point_t){290, 90}, 2, path, 8) == 3);
    assert(path[0].x == 100 && path[0].y == 50);
    assert(path[1].x == 200 && path[1].y == 50);
    assert(path[2].x == 290 && path[2].y == 90);
}

static void ConnectsOneWayOnly(void)
{
    nav_point_t path[8];

    // Room 2 is a ledge: down from it is fine, up onto it is not
    B_NavReset(3);
    B_NavConnect(0, 1, door01);
    B_NavConnect(1, 0, door01);
    B_NavConnect(2, 1, door12);

    assert(B_NavPath((nav_point_t){10, 10}, 0, (nav_point_t){290, 90}, 2, path, 8) == 0);
    assert(B_NavPath((nav_point_t){290, 90}, 2, (nav_point_t){10, 10}, 0, path, 8) == 3);
}

// A ring of four rooms. From the bottom of room 0 to the bottom of room 3
// is short through the door between them, and long round by 1 and 2.
//
//   1 | 2
//   -----
//   0 | 3
static void TakesTheShortestWay(void)
{
    nav_point_t path[8];
    nav_point_t doors[] = {{50, 100}, {100, 150}, {150, 100}, {100, 50}};
    int i;

    B_NavReset(4);

    for (i = 0; i < 4; ++i)
    {
        B_NavConnect(i, (i + 1) % 4, doors[i]);
        B_NavConnect((i + 1) % 4, i, doors[i]);
    }

    assert(B_NavPath((nav_point_t){50, 10}, 0, (nav_point_t){150, 10}, 3, path, 8) == 2);
    assert(path[0].x == 100 && path[0].y == 50);
}

static void GivesUpOnRoutesLongerThanAskedFor(void)
{
    nav_point_t path[8];

    ThreeRooms();

    assert(B_NavPath((nav_point_t){10, 10}, 0, (nav_point_t){290, 90}, 2, path, 2) == 0);
}

// The same ring, after the player got stuck in the short way's door
static void AvoidsCrossingsThatFailed(void)
{
    nav_point_t path[8];
    nav_point_t doors[] = {{50, 100}, {100, 150}, {150, 100}, {100, 50}};
    int i;

    B_NavReset(4);

    for (i = 0; i < 4; ++i)
    {
        B_NavConnect(i, (i + 1) % 4, doors[i]);
        B_NavConnect((i + 1) % 4, i, doors[i]);
    }

    B_NavAvoid((nav_point_t){100, 50});

    assert(B_NavPath((nav_point_t){50, 10}, 0, (nav_point_t){150, 10}, 3, path, 8) == 4);
    assert(path[0].x == 50 && path[0].y == 100);
}

int main(void)
{
    WalksStraightWithinAnArea();
    CrossesWhereAreasConnect();
    ConnectsOneWayOnly();
    TakesTheShortestWay();
    GivesUpOnRoutesLongerThanAskedFor();
    AvoidsCrossingsThatFailed();
    puts("b_nav: ok");
    return 0;
}
