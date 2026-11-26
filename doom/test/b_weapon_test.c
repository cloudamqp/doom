// Unit tests of the bot's choice of weapon, run with: make test

#include <assert.h>
#include <stdio.h>

#include "b_weapon.h"

#define NEAR 100
#define FAR  800

static const boolean all[B_WEAPONS] = {true, true, true, true, true, true};
static const int plenty[B_WEAPONS] = {1, 50, 50, 50, 50, 50};

static void KeepsRocketsForADistance(void)
{
    boolean owned[B_WEAPONS] = {true, true, true, false, true, false};

    // A rocket that goes off close by hurts the one who fired it
    assert(B_BestWeapon(owned, plenty, NEAR, B_PISTOL) == B_SHOTGUN);
    assert(B_BestWeapon(owned, plenty, FAR, B_PISTOL) == B_ROCKETS);
}

static void PrefersPlasmaAtAnyRange(void)
{
    assert(B_BestWeapon(all, plenty, NEAR, B_PISTOL) == B_PLASMA);
    assert(B_BestWeapon(all, plenty, FAR, B_PISTOL) == B_PLASMA);
}

static void TakesTheChaingunOverThePistol(void)
{
    boolean owned[B_WEAPONS] = {true, true, false, true, false, false};

    assert(B_BestWeapon(owned, plenty, FAR, B_PISTOL) == B_CHAINGUN);
}

static void SkipsWeaponsWithoutAmmo(void)
{
    int shots[B_WEAPONS] = {1, 50, 50, 50, 50, 0};

    assert(B_BestWeapon(all, shots, FAR, B_PISTOL) == B_ROCKETS);
}

static void FightsWithFistsWhenAllElseIsEmpty(void)
{
    int shots[B_WEAPONS] = {1, 0, 0, 0, 0, 0};

    assert(B_BestWeapon(all, shots, NEAR, B_PISTOL) == B_FIST);
}

// A player 256 units away is at the edge of where rockets are safe. One
// who steps to and fro there must not have the bot change weapons with
// every step: a change takes most of a second, in which it cannot fire.
static void StaysWithItsWeaponAroundTheEdge(void)
{
    boolean owned[B_WEAPONS] = {true, true, true, false, true, false};

    assert(B_BestWeapon(owned, plenty, 240, B_ROCKETS) == B_ROCKETS);
    assert(B_BestWeapon(owned, plenty, 280, B_SHOTGUN) == B_SHOTGUN);
    // Well inside and well outside, it changes
    assert(B_BestWeapon(owned, plenty, 150, B_ROCKETS) == B_SHOTGUN);
    assert(B_BestWeapon(owned, plenty, 400, B_SHOTGUN) == B_ROCKETS);
}

int main(void)
{
    KeepsRocketsForADistance();
    PrefersPlasmaAtAnyRange();
    TakesTheChaingunOverThePistol();
    SkipsWeaponsWithoutAmmo();
    FightsWithFistsWhenAllElseIsEmpty();
    StaysWithItsWeaponAroundTheEdge();
    puts("b_weapon: ok");
    return 0;
}
