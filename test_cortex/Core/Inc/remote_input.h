#ifndef REMOTE_INPUT_H
#define REMOTE_INPUT_H

#include <stdint.h>

/*
 * Source-independent remote snapshot.
 * On the H7 this can come from local DBUS or from the board-to-board CAN
 * link; on the C8T6 fixture it is produced by the local SBUS module. The
 * snapshot is value semantics: callers copy it and never treat it as a
 * writable handle into the underlying input.
 */
typedef struct
{
    int16_t ch[4];
    int8_t  s[4];

    uint8_t dbus_lost;
    uint8_t frame_lost;
    uint8_t failsafe;
    uint8_t gimbal_mode;   /* reserved on the C8T6 fixture (always 0) */

    uint16_t sequence;
    uint32_t timestamp_ms;
    uint8_t  online;
} remote_input_snapshot_t;

#endif /* REMOTE_INPUT_H */
