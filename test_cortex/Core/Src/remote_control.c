/**
 * remote_control: SBUS remote parsing, ported from the H7 remote-control
 * structure onto the C8T6 fixture.
 *
 *   - Frames arrive through bsp_usart (circular DMA + UART IDLE framing) and
 *     are parsed in the bsp callback context, so only cheap work happens here.
 *   - The switch mapping matches the H7 project: UP -> 1, DOWN -> 2, MID -> 3.
 *   - detect_task/DBUS_TOE was replaced by a local last-frame timestamp; the
 *     protocol layer itself does not depend on the debug infrastructure.
 */
#include "remote_control.h"
#include "main.h"

#include <math.h>

/* Input: 1 = mid, 2 = down, 3 = up (three-position switch raw ordering)
 * Output: up -> 1, mid -> 3, down -> 2 */
#define MAP(val)  ((val < 0) ? 1 : (val > 0) ? 2 : 3)

#define MAPPING_ENABLE 1

/* Upper limit for a channel value before the frame is considered bad. */
#define RC_CHANNAL_ERROR_VALUE 700

static int16_t RC_abs(int16_t value);
static void sbus_to_rc(volatile const uint8_t *sbus_buf, RC_ctrl_t *rc_ctrl);
static int16_t map_to_660(const int16_t val);

/* Remote control data. */
RC_ctrl_t rc_ctrl;

/* Raw receive buffer; the bsp layer frames it with the IDLE interrupt. */
uint8_t sbus_rx_buf[SBUS_RX_BUF_NUM];
volatile uint16_t remote_sequence;
volatile uint32_t remote_timestamp_ms;

/* Frame callback: the bsp layer has already framed the data by IDLE. */
static void rc_sbus_rx_callback(bsp_uart_id_t uartx, uint8_t *data, uint16_t size)
{
    (void)uartx;
    if (size == RC_FRAME_LENGTH)
    {
        sbus_to_rc(data, &rc_ctrl);
        remote_sequence++;
        remote_timestamp_ms = HAL_GetTick();
    }
}

void remote_control_init(void)
{
    /* Register the logical USART2 receive path and the SBUS frame parser. */
    RC_Init(BSP_UART2, sbus_rx_buf, SBUS_RX_BUF_NUM);
    bsp_uart_dma_rx_register_cb(BSP_UART2, rc_sbus_rx_callback);
}

const RC_ctrl_t *get_remote_control_point(void)
{
    return &rc_ctrl;
}

uint8_t remote_control_is_online(void)
{
    if (remote_timestamp_ms == 0u)
    {
        return 0u;
    }
    return ((HAL_GetTick() - remote_timestamp_ms) < RC_ONLINE_TIMEOUT_MS) ? 1u : 0u;
}

uint16_t remote_control_sequence(void)
{
    return remote_sequence;
}

void remote_control_read_snapshot(remote_input_snapshot_t *snapshot)
{
    uint32_t primask;
    uint8_t i;

    if (snapshot == NULL)
        return;

    primask = __get_PRIMASK();
    __disable_irq();
    for (i = 0u; i < 4u; i++) {
        snapshot->ch[i] = rc_ctrl.rc.ch[i];
        snapshot->s[i] = rc_ctrl.rc.s[i];
    }
    snapshot->frame_lost = rc_ctrl.rc.frame_lost;
    snapshot->failsafe = rc_ctrl.rc.failsafe;
    snapshot->sequence = remote_sequence;
    snapshot->timestamp_ms = remote_timestamp_ms;
    snapshot->dbus_lost = remote_control_is_online() ? 0u : 1u;
    snapshot->online = snapshot->dbus_lost ? 0u : 1u;
    __DMB();
    if (primask == 0u)
        __enable_irq();
}

/* Safe state after a lost/bad frame: sticks centered, all switches UP.
 * The H7 note still applies here: this project maps UP to the idle behavior,
 * so a safe reset must not copy the DJI-original "all DOWN" pattern. */
void rc_safe_reset(void)
{
    for (int i = 0; i < 4; i++)
    {
        rc_ctrl.rc.ch[i] = 0;
        rc_ctrl.rc.s[i]  = RC_SW_UP;
    }
    rc_ctrl.rc.vr[0] = 0;
    rc_ctrl.rc.vr[1] = 0;
    rc_ctrl.rc.failsafe  = 1;
    rc_ctrl.rc.frame_lost = 1;
    rc_ctrl.mouse.x = 0;
    rc_ctrl.mouse.y = 0;
    rc_ctrl.mouse.z = 0;
    rc_ctrl.mouse.press_l = 0;
    rc_ctrl.mouse.press_r = 0;
    rc_ctrl.key.v = 0;
}

uint8_t RC_data_is_error(void)
{
    if (RC_abs(rc_ctrl.rc.ch[0]) > RC_CHANNAL_ERROR_VALUE)
    {
        goto error;
    }
    if (RC_abs(rc_ctrl.rc.ch[1]) > RC_CHANNAL_ERROR_VALUE)
    {
        goto error;
    }
    if (RC_abs(rc_ctrl.rc.ch[2]) > RC_CHANNAL_ERROR_VALUE)
    {
        goto error;
    }
    if (RC_abs(rc_ctrl.rc.ch[3]) > RC_CHANNAL_ERROR_VALUE)
    {
        goto error;
    }
    if (rc_ctrl.rc.s[0] == 0)
    {
        goto error;
    }
    if (rc_ctrl.rc.s[1] == 0)
    {
        goto error;
    }
    return 0;

error:
    rc_safe_reset();
    return 1;
}

void slove_RC_lost(void)
{
    RC_restart(SBUS_RX_BUF_NUM);
}

void slove_data_error(void)
{
    RC_restart(SBUS_RX_BUF_NUM);
}

static int16_t RC_abs(int16_t value)
{
    if (value > 0)
    {
        return value;
    }
    else
    {
        return -value;
    }
}

/* SBUS protocol resolution: 25-byte frame, 0x0F header, 0x00 footer.
 * Another protocol can be added here (or in a sibling callback) without
 * changing the bsp_usart receive layer. */
static void sbus_to_rc(volatile const uint8_t *sbus_buf, RC_ctrl_t *rc_ctrl)
{
    if (sbus_buf == NULL || rc_ctrl == NULL)
    {
        return;
    }

    /* Header/footer check (standard SBUS: 0x0F ... 0x00). */
    if (sbus_buf[0] != 0x0F || sbus_buf[24] != 0x00)
    {
        return;
    }

    /* Four proportional channels. */
    rc_ctrl->rc.ch[0] = (int16_t)(((sbus_buf[1] | (sbus_buf[2] << 8)) & 0x07FF) - RC_CH_VALUE_OFFSET);
    rc_ctrl->rc.ch[1] = (int16_t)((((sbus_buf[2] >> 3) | (sbus_buf[3] << 5)) & 0x07FF) - RC_CH_VALUE_OFFSET);
    rc_ctrl->rc.ch[2] = (int16_t)((((sbus_buf[3] >> 6) | (sbus_buf[4] << 2) | (sbus_buf[5] << 10)) & 0x07FF) - RC_CH_VALUE_OFFSET);
    rc_ctrl->rc.ch[3] = (int16_t)((((sbus_buf[5] >> 1) | (sbus_buf[6] << 7)) & 0x07FF) - RC_CH_VALUE_OFFSET);

    /* Four three-position switches. */
    rc_ctrl->rc.s[0] = (int8_t) MAP(((sbus_buf[6] >> 4 | sbus_buf[7] << 4) & 0x07FF) - RC_CH_VALUE_OFFSET);
    rc_ctrl->rc.s[1] = (int8_t) MAP(((sbus_buf[7] >> 7 | sbus_buf[8] << 1 | sbus_buf[9] << 9) & 0x07FF) - RC_CH_VALUE_OFFSET);
    rc_ctrl->rc.s[2] = (int8_t) MAP(((sbus_buf[9] >> 2 | sbus_buf[10] << 6) & 0x07FF) - RC_CH_VALUE_OFFSET);
    rc_ctrl->rc.s[3] = (int8_t) MAP(((sbus_buf[10] >> 5 | sbus_buf[11] << 3) & 0x07FF) - RC_CH_VALUE_OFFSET);

    /* VRA, VRB. */
    rc_ctrl->rc.vr[0] = (int16_t)((sbus_buf[12] | sbus_buf[13] << 8) & 0x07FF) - RC_CH_VALUE_OFFSET;
    rc_ctrl->rc.vr[1] = (int16_t)((sbus_buf[13] >> 3 | sbus_buf[14] << 5) & 0x07FF) - RC_CH_VALUE_OFFSET;

#if MAPPING_ENABLE
    for (int i = 0; i < 4; i++)
    {
        rc_ctrl->rc.ch[i] = map_to_660(rc_ctrl->rc.ch[i]);
    }
    for (int i = 0; i < 2; i++)
    {
        rc_ctrl->rc.vr[i] = map_to_660(rc_ctrl->rc.vr[i]);
    }

    /* Lost frame / failsafe flags. */
    const uint8_t flag = sbus_buf[23];
    rc_ctrl->rc.frame_lost = (flag >> 2) & 0x01;
    rc_ctrl->rc.failsafe = (flag >> 3) & 0x01;
#endif
}

/**
 * Maps the raw SBUS range (-784..783) to -660..660 for uniform consumers.
 */
static int16_t map_to_660(const int16_t val)
{
    if (val >= 0)
        return (int16_t)floorf((660.0f / 783.0f) * (float)val + 0.5f);
    else
        return (int16_t)floorf((660.0f / 784.0f) * (float)val + 0.5f);
}
