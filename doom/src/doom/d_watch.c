//
// What spectators see: where the players and monsters are, and the scores.
// A few times a second the page gets it, and the host publishes it, see
// web/js/play.js and web/js/watch.js.
//

#include <emscripten.h>

#include "d_watch.h"
#include "doomstat.h"
#include "net_client.h"
#include "p_local.h"

#define EVERY 4           // tics, about 9 times a second
#define MONSTERS_EVERY 16 // tics, about twice a second
#define MAX_MONSTERS 1024
#define FIELDS 9          // per player, as read below

EM_JS_DEPS(d_watch, "$UTF8ToString");
EM_JS(void, JS_Watch, (const int *numbers, const char *names, int name_size, const int *monsters, int monster_count), {
    if (!Module.onWatch) return;
    const number = (i) => HEAP32[(numbers >> 2) + i];
    const players = [];
    for (let i = 0; i < 4; i++) {
        const [ingame, x, y, angle, health, armor, frags, kills, dead] =
            Array.from({ length: 9 }, (_, field) => number(5 + i * 9 + field));
        if (!ingame) continue;
        const name = UTF8ToString(names + i * name_size) || `Player ${i + 1}`;
        players.push({ number: i, name, x, y, angle, health, armor, frags, kills, dead: dead === 1 });
    }
    const watch = {
        state: ["level", "intermission", "finale", "demo"][number(0)],
        map: number(1) ? `E${number(1)}M${number(2)}` : `MAP${String(number(2)).padStart(2, "0")}`,
        time: number(3),
        deathmatch: number(4) > 0,
        players,
    };
    if (monsters) watch.monsters = Array.from(HEAP32.subarray(monsters >> 2, (monsters >> 2) + 2 * monster_count));
    Module.onWatch(watch);
});

// Frags as the status bar counts them: others fragged, less suicides
static int Frags(const player_t *player, int number)
{
    int frags = 0;

    for (int i = 0; i < MAXPLAYERS; i++)
        frags += i == number ? -player->frags[i] : player->frags[i];
    return frags;
}

static int Monsters(int *positions)
{
    int count = 0;

    for (thinker_t *th = thinkercap.next; th != &thinkercap && count < MAX_MONSTERS; th = th->next) {
        if (th->function.acp1 != (actionf_p1) P_MobjThinker)
            continue;
        const mobj_t *mo = (const mobj_t *) th;
        if (!(mo->flags & MF_COUNTKILL) || mo->health <= 0)
            continue;
        positions[2 * count] = mo->x >> FRACBITS;
        positions[2 * count + 1] = mo->y >> FRACBITS;
        count++;
    }
    return count;
}

void D_Watch(void)
{
    static int last = -EVERY;
    static int numbers[5 + MAXPLAYERS * FIELDS];
    static int monsters[2 * MAX_MONSTERS];

    if (!netgame || gametic - last < EVERY)
        return;
    boolean with_monsters = gametic / MONSTERS_EVERY != last / MONSTERS_EVERY;
    last = gametic;

    numbers[0] = gamestate;
    numbers[1] = gamemode == commercial ? 0 : gameepisode;
    numbers[2] = gamemap;
    numbers[3] = leveltime;
    numbers[4] = deathmatch;
    for (int i = 0; i < MAXPLAYERS; i++) {
        const player_t *player = &players[i];
        int *fields = &numbers[5 + i * FIELDS];
        fields[0] = playeringame[i] && player->mo != NULL;
        if (!fields[0])
            continue;
        fields[1] = player->mo->x >> FRACBITS;
        fields[2] = player->mo->y >> FRACBITS;
        fields[3] = player->mo->angle >> 24; // 256 to a turn
        fields[4] = player->health;
        fields[5] = player->armorpoints;
        fields[6] = Frags(player, i);
        fields[7] = player->killcount;
        fields[8] = player->playerstate == PST_DEAD;
    }

    int count = with_monsters ? Monsters(monsters) : 0;
    JS_Watch(numbers, net_client_wait_data.player_names[0], MAXPLAYERNAME, with_monsters ? monsters : NULL, count);
}
