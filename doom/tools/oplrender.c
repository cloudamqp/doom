//
// Renders a song from an IWAD the way the game plays it: through Chocolate
// Doom's OPL music player and OPL3 emulator, with the IWAD's own GENMIDI
// instruments. bin/build.sh renders the lobby's music with it:
//
//   node oplrender.cjs freedoom1.wad D_E1M1 song.wav
//
// The WAV holds one pass through the song, which ends where the game loops
// it, in 16-bit stereo at 44100 Hz.
//

#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>

#include "deh_str.h"
#include "i_sound.h"
#include "i_system.h"
#include "opl.h"
#include "opl3.h"
#include "opl_internal.h"
#include "opl_queue.h"

#define RATE 44100
#define SLICE (OPL_SECOND / 10)

extern music_module_t music_opl_module;

// Read by I_OPL_InitMusic, i_sound.c has it in the game
int snd_samplerate = RATE;

static uint8_t *wad;
static long wad_size;

static void Fail(const char *message, const char *detail)
{
    fprintf(stderr, "oplrender: %s%s\n", message, detail);
    exit(1);
}

static void LoadWad(const char *path)
{
    FILE *file = fopen(path, "rb");
    if (file == NULL)
        Fail("can't open ", path);
    fseek(file, 0, SEEK_END);
    wad_size = ftell(file);
    rewind(file);
    wad = malloc(wad_size);
    if (fread(wad, 1, wad_size, file) != (size_t) wad_size)
        Fail("can't read ", path);
    fclose(file);
}

static int32_t Int32(const uint8_t *p)
{
    return p[0] | p[1] << 8 | p[2] << 16 | (int32_t) p[3] << 24;
}

static void *FindLump(const char *name, int *size)
{
    int32_t count = Int32(wad + 4), directory = Int32(wad + 8);
    for (int32_t i = 0; i < count; i++)
    {
        const uint8_t *entry = wad + directory + 16 * i;
        if (strncasecmp((const char *) entry + 8, name, 8) == 0)
        {
            if (size != NULL)
                *size = Int32(entry + 4);
            return wad + Int32(entry);
        }
    }
    Fail("no lump ", name);
    return NULL;
}

// What the music player needs from the rest of the game

void *W_CacheLumpName(const char *name, int tag)
{
    return FindLump(name, NULL);
}

void W_ReleaseLumpName(const char *name)
{
}

void *Z_Malloc(int size, int tag, void *user)
{
    void *memory = malloc(size);
    if (memory == NULL)
        Fail("out of memory", "");
    return memory;
}

void Z_Free(void *memory)
{
    free(memory);
}

void *I_Realloc(void *memory, size_t size)
{
    memory = realloc(memory, size);
    if (memory == NULL)
        Fail("out of memory", "");
    return memory;
}

const char *DEH_String(const char *text)
{
    return text;
}

void I_Error(const char *error, ...)
{
    va_list args;
    va_start(args, error);
    vfprintf(stderr, error, args);
    va_end(args);
    fputc('\n', stderr);
    exit(1);
}

// An OPL driver that renders to a file as fast as it can, in the place of
// opl_sdl.c, which plays through SDL in real time. Same emulator, same
// timing: run the emulator up to the next callback, then call it.

static opl3_chip chip;
static opl_callback_queue_t *queue;
static uint64_t now; // us since the start
static unsigned int reg;

static int Init(unsigned int port_base)
{
    queue = OPL_Queue_Create();
    OPL3_Reset(&chip, RATE);
    return 1;
}

static void Shutdown(void)
{
    OPL_Queue_Destroy(queue);
}

static unsigned int ReadPort(opl_port_t port)
{
    return port == OPL_REGISTER_PORT_OPL3 ? 0xff : 0;
}

static void WritePort(opl_port_t port, unsigned int value)
{
    if (port == OPL_REGISTER_PORT)
        reg = value;
    else if (port == OPL_REGISTER_PORT_OPL3)
        reg = value | 0x100;
    else if (reg != OPL_REG_TIMER1 && reg != OPL_REG_TIMER2 && reg != OPL_REG_TIMER_CTRL)
        OPL3_WriteRegBuffered(&chip, reg, value);
}

static void SetCallback(uint64_t us, opl_callback_t callback, void *data)
{
    OPL_Queue_Push(queue, callback, data, now + us);
}

static void ClearCallbacks(void)
{
    OPL_Queue_Clear(queue);
}

static void Unlocked(void)
{
}

static void SetPaused(int paused)
{
}

static void AdjustCallbacks(float factor)
{
    OPL_Queue_AdjustCallbacks(queue, now, factor);
}

// opl.c picks this driver up by this name
opl_driver_t opl_sdl_driver = {
    "render",    Init,     Shutdown,  ReadPort,         WritePort, SetCallback,
    ClearCallbacks, Unlocked, Unlocked, SetPaused, AdjustCallbacks,
};

static void Int32Out(FILE *out, uint32_t value)
{
    uint8_t bytes[4] = {value, value >> 8, value >> 16, value >> 24};
    fwrite(bytes, 1, 4, out);
}

// A 16-bit stereo WAV header, for data_size bytes of samples
static void WavHeader(FILE *out, uint32_t data_size)
{
    fwrite("RIFF", 1, 4, out);
    Int32Out(out, 36 + data_size);
    fwrite("WAVEfmt ", 1, 8, out);
    Int32Out(out, 16);
    Int32Out(out, 1 | 2 << 16);  // PCM, 2 channels
    Int32Out(out, RATE);
    Int32Out(out, RATE * 4);     // bytes per second
    Int32Out(out, 4 | 16 << 16); // bytes per sample, bits per channel
    fwrite("data", 1, 4, out);
    Int32Out(out, data_size);
}

static void Render(FILE *out, uint64_t until)
{
    static int16_t buffer[RATE * 2];

    while (now < until)
    {
        uint64_t next = until;
        if (!OPL_Queue_IsEmpty(queue) && OPL_Queue_Peek(queue) < next)
            next = OPL_Queue_Peek(queue);

        uint64_t samples = ((next - now) * RATE + OPL_SECOND - 1) / OPL_SECOND;
        if (samples > RATE)
            samples = RATE;
        OPL3_GenerateStream(&chip, buffer, samples);
        fwrite(buffer, 4, samples, out);
        now += samples * OPL_SECOND / RATE;

        opl_callback_t callback;
        void *data;
        while (!OPL_Queue_IsEmpty(queue) && now >= OPL_Queue_Peek(queue)
               && OPL_Queue_Pop(queue, &callback, &data))
            callback(data);
    }
}

int main(int argc, char **argv)
{
    if (argc != 4)
        Fail("usage: oplrender <iwad> <music lump> <output.wav>", "");

    LoadWad(argv[1]);
    int size;
    void *song = FindLump(argv[2], &size);
    FILE *out = fopen(argv[3], "wb");
    if (out == NULL)
        Fail("can't write ", argv[3]);
    WavHeader(out, 0);

    if (!music_opl_module.Init())
        Fail("no OPL", "");
    music_opl_module.SetMusicVolume(127);
    void *handle = music_opl_module.RegisterSong(song, size);
    if (handle == NULL)
        Fail("can't play ", argv[2]);
    music_opl_module.PlaySong(handle, 0);

    // The player schedules no more callbacks once a song that doesn't loop ends
    while (!OPL_Queue_IsEmpty(queue))
        Render(out, now + SLICE);

    music_opl_module.Shutdown();
    long end = ftell(out);
    rewind(out);
    WavHeader(out, end - 44);
    fclose(out);
    return 0;
}
