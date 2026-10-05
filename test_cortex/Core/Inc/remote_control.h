#ifndef REMOTE_CONTROL_H
#define REMOTE_CONTROL_H

#include <stdint.h>
#include "bsp_rc.h"
#include "remote_input.h"

/* Ported from the H7 remote-control structure (SBUS-like protocol, DMA RX
 * with UART IDLE framing). The C8T6 fixture receives on USART2. */

#define SBUS_RX_BUF_NUM 64u

#define RC_FRAME_LENGTH 25u

#define RC_CH_VALUE_MIN         ((uint16_t)364)
#define RC_CH_VALUE_OFFSET      ((uint16_t)1024)
#define RC_CH_VALUE_MAX         ((uint16_t)1684)

/* The input is considered lost when no valid frame arrived for this long. */
#define RC_ONLINE_TIMEOUT_MS    100u

/* ----------------------- RC Switch Definition ---------------------------- */
#define RC_SW_UP                ((uint16_t)1)
#define RC_SW_MID               ((uint16_t)3)
#define RC_SW_DOWN              ((uint16_t)2)
#define switch_is_down(s)       (s == RC_SW_DOWN)
#define switch_is_mid(s)        (s == RC_SW_MID)
#define switch_is_up(s)         (s == RC_SW_UP)

/* ----------------------- PC Key Definition (DJI DBUS only) --------------- */
#define KEY_PRESSED_OFFSET_W            ((uint16_t)1 << 0)
#define KEY_PRESSED_OFFSET_S            ((uint16_t)1 << 1)
#define KEY_PRESSED_OFFSET_A            ((uint16_t)1 << 2)
#define KEY_PRESSED_OFFSET_D            ((uint16_t)1 << 3)
#define KEY_PRESSED_OFFSET_SHIFT        ((uint16_t)1 << 4)
#define KEY_PRESSED_OFFSET_CTRL         ((uint16_t)1 << 5)
#define KEY_PRESSED_OFFSET_Q            ((uint16_t)1 << 6)
#define KEY_PRESSED_OFFSET_E            ((uint16_t)1 << 7)
#define KEY_PRESSED_OFFSET_R            ((uint16_t)1 << 8)
#define KEY_PRESSED_OFFSET_F            ((uint16_t)1 << 9)
#define KEY_PRESSED_OFFSET_G            ((uint16_t)1 << 10)
#define KEY_PRESSED_OFFSET_Z            ((uint16_t)1 << 11)
#define KEY_PRESSED_OFFSET_X            ((uint16_t)1 << 12)
#define KEY_PRESSED_OFFSET_C            ((uint16_t)1 << 13)
#define KEY_PRESSED_OFFSET_V            ((uint16_t)1 << 14)
#define KEY_PRESSED_OFFSET_B            ((uint16_t)1 << 15)

/* ----------------------- Internal Data ----------------------------------- */
#define RC_CH0_RLR_OFFSET    (get_remote_control_point()->rc.ch[0])
#define RC_CH1_RUD_OFFSET    (get_remote_control_point()->rc.ch[1])
#define RC_CH2_LLR_OFFSET    (get_remote_control_point()->rc.ch[2])
#define RC_CH3_LUD_OFFSET    (get_remote_control_point()->rc.ch[3])

/* Remote switch states */
#define IF_RC_SW1_UP      (get_remote_control_point()->rc.s[0] == RC_SW_UP)
#define IF_RC_SW1_MID     (get_remote_control_point()->rc.s[0] == RC_SW_MID)
#define IF_RC_SW1_DOWN    (get_remote_control_point()->rc.s[0] == RC_SW_DOWN)
#define IF_RC_SW2_UP      (get_remote_control_point()->rc.s[1] == RC_SW_UP)
#define IF_RC_SW2_MID     (get_remote_control_point()->rc.s[1] == RC_SW_MID)
#define IF_RC_SW2_DOWN    (get_remote_control_point()->rc.s[1] == RC_SW_DOWN)

/* Mouse data (DJI DBUS only; kept for structure parity) */
#define MOUSE_X_MOVE_SPEED    (get_remote_control_point()->mouse.x)
#define MOUSE_Y_MOVE_SPEED    (get_remote_control_point()->mouse.y)
#define MOUSE_Z_MOVE_SPEED    (get_remote_control_point()->mouse.z)
#define IF_MOUSE_PRESSED_LEFT    (get_remote_control_point()->mouse.press_l == 1)
#define IF_MOUSE_PRESSED_RIGH    (get_remote_control_point()->mouse.press_r == 1)
#define IF_KEY_PRESSED         (get_remote_control_point()->key.v)

/* ----------------------- Data Struct ------------------------------------- */
typedef struct __attribute__((packed))
{
        struct __attribute__((packed))
        {
            int16_t ch[4];
            int8_t s[4];
            int16_t vr[2];
            uint8_t failsafe;  /* failsafe flag bit */
            uint8_t frame_lost;
        } rc;
        struct __attribute__((packed))
        {
                int16_t x;
                int16_t y;
                int16_t z;
                uint8_t press_l;
                uint8_t press_r;
        } mouse;
        struct __attribute__((packed))
        {
                uint16_t v;
        } key;

} RC_ctrl_t;

/* ----------------------- Functions --------------------------------------- */
void remote_control_init(void);
const RC_ctrl_t *get_remote_control_point(void);
uint8_t RC_data_is_error(void);
void slove_RC_lost(void);
void slove_data_error(void);
void rc_safe_reset(void);   /* lost/bad frame: sticks centered, switches UP */
uint8_t remote_control_is_online(void);
uint16_t remote_control_sequence(void);
void remote_control_read_snapshot(remote_input_snapshot_t *snapshot);

#endif
